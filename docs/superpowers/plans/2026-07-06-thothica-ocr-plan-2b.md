# Thothica OCR SaaS, plan 2b of N: the OCR loop (batch pipeline, artifacts, downloads)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A reflow job runs end to end: upload, submit every page to the Mistral batch OCR endpoint, poll to completion on a cron, assemble the normalized document, store the light artifacts, capture credits, and let the user download a reflowable EPUB, Markdown, and DOCX. This is the piece that makes the product actually produce output.

**Why batch, settled by real files:** Adnan's four test PDFs are 17, 152, 206, and 210 pages. Realtime per-page OCR of a 200-page book is 10+ minutes and exceeds request and queue limits. The Mistral batch endpoint (verified: supports `/v1/ocr`, 50 percent cheaper, JSONL with `custom_id`, up to 1M requests) is the only feasible path at this size and is also Adnan's stated default. Express (realtime, flat fee) is a later small variant that reuses the same assembly, only swapping the OCR call.

**Architecture (async, four moving parts):**
1. On start (already builds hold in plan 2a): the container rasterizes and trims every page, writes each page PNG plus its pixel size to R2 (`pages/{jobId}/`), builds a batch JSONL (one line per page, `custom_id = jobId:pageIndex`, body an `/v1/ocr` request with the page as a base64 `image_url`), and submits it to Mistral. The Worker records `batch_id` and moves the job to `awaiting_ocr`. The original upload is deleted once page PNGs exist.
2. A **cron Worker** (every ~2 minutes) lists `awaiting_ocr` jobs, polls each `batch_id`; on completion it downloads the results and moves the job to `assembling`, then invokes assembly.
3. **Assembly**: the container receives the OCR results plus the stored page PNGs and sizes, runs the existing reflow assembly (`parse_ocr_reflow` + `build_doc`), and returns the verbatim OCR JSON, the normalized `doc.json`, the normalized Markdown, and any figure crop assets. The Worker stores verbatim + doc.json + md + figure assets in R2, captures the hold, deletes the page PNGs, and marks the job `ready`.
4. **Downloads**: `GET /api/jobs/:id/download?format=epub|md|docx` fetches `doc.json` and figure assets from R2, asks the container to render that format, and streams the file. Markdown is served directly from R2 (already stored); EPUB and DOCX are rendered on demand (deterministic, not stored).

**Engine reuse:** `convert_book_reflow` (src/pdf2fxl/reflow/pipeline_reflow.py) already takes an injected `ocr_fn` and writes `doc.json`. The container splits it into `rasterize+submit` and `assemble+render` around the batch boundary, reusing `rasterize_page`, `_trim`, `parse_ocr_reflow`, `build_doc`, and the three renderers unchanged. Do NOT modify `src/pdf2fxl/`; import it.

**Secrets and access:** the Worker holds `MISTRAL_API_KEY` (already set as a Worker secret) and passes it to the container per request over the internal container binding (never public, never in the image). The container has no D1 and no direct R2; the Worker streams bytes both ways and owns every store write, keeping the container pure compute.

**Verification (house rule):** the done gate is a real run of the 17-page `Pareeksha Technologies.pdf` (fast) and at least one large book (the 152-page microbiome) through the deployed pipeline, downloading the EPUB and rendering it to images to eyeball, before claiming done. Fixture-level tests gate each task; the batch submit and poll are tested against a recorded Mistral batch response, not the live API, in unit tests.

**Execution notes:** working dir `cloud/worker/` for TS, repo venv for Python container tests. Every task keeps the worker suite (currently 71) and the engine suite (85) green. Commits carry the Co-Authored-By trailer. Do not push mid-plan; the controller deploys at the verification task.

**Open risk to confirm in Task 1 (spike):** whether one whole-book assembly fits the container and Worker time budget, and the exact Mistral batch submit/retrieve request shape (input file upload via the Files API, then `client.batch.jobs.create`). Task 1 answers both against the real API with the 17-page file before any lifecycle code is written.

---

### Task 1: Spike, prove the batch OCR round trip on a real file

Not test-first; this is a throwaway investigation whose output is a short findings note committed to `docs/superpowers/notes/2026-07-06-mistral-batch-ocr-spike.md`, plus a reusable `cloud/container/ocr_batch.py` helper if it proves out. Run locally with the repo venv and the real `MISTRAL_API_KEY` from `.env`.

- [ ] Rasterize the 17-page `/Users/siraj/Downloads/test/Pareeksha Technologies.pdf` with the engine's `rasterize_page`, base64 each page as an `image_url` OCR request, write a JSONL.
- [ ] Upload the JSONL via the Mistral Files API (`purpose="batch"`), create a batch job against `/v1/ocr`, poll until complete, download and parse the results.
- [ ] Confirm each result line carries pages/markdown/blocks with bboxes usable by `parse_ocr_reflow`. Feed one page through `parse_ocr_reflow` and `build_doc` to confirm the shape matches.
- [ ] Record: exact SDK calls and JSON shapes, wall-clock for 17 pages, whether a whole-PDF single-request (`document_url` base64) is viable as an alternative, cost observed. Write the findings note. Commit `docs: mistral batch OCR spike findings`.

If the batch round trip does not work as expected, STOP and report to the controller with the findings before proceeding; the lifecycle tasks depend on this shape.

### Task 2: Job columns and states for the batch lifecycle

Migration `0003_ocr_lifecycle.sql`: confirm `batch_id`, `r2_verbatim_key`, `r2_doc_key`, `r2_md_key` exist (they do from 0002) and add `r2_pages_prefix TEXT` and `ocr_submitted_at TEXT`. Tests assert the columns exist and default null. The `awaiting_ocr` and `assembling` states already exist in the 0002 CHECK. Commit.

### Task 3: Container `/submit` endpoint (rasterize, JSONL, Mistral batch submit)

`cloud/container/app.py`: add `POST /submit` taking the PDF bytes, `mode`, and the Mistral key (header `x-mistral-key`). It rasterizes and trims each page (reusing engine functions), returns a multipart or JSON response containing, per page, the PNG bytes (base64) and pixel size, and it submits the batch to Mistral and returns `{ batch_id, page_count, pages: [{index, width, height}] }`. The page PNGs come back to the Worker for storage; the container keeps nothing. pytest with a mocked Mistral client (submit returns a fake batch id) plus a real 3-page synthetic PDF. Commit.

### Task 4: Worker start wiring, store pages, record batch, move to awaiting_ocr

Extend `startJob` (src/start.ts): after the hold, call container `/submit`, stream each returned page PNG to R2 under `pages/{jobId}/p{n}.png`, store sizes in `pages/{jobId}/index.json`, set `batch_id`, `r2_pages_prefix`, `ocr_submitted_at`, transition `processing -> awaiting_ocr`, delete the original upload. On any failure, failJob + releaseHold. Tests use an injected submit stub (mirroring the existing `EnginePrepare` injection) so no container or Mistral is needed. Commit.

### Task 5: Cron Worker, poll batches, drive completion

Add a `scheduled` handler and `"triggers": { "crons": ["*/2 * * * *"] }`. It selects `awaiting_ocr` jobs, polls each `batch_id` via an injected poller (real one calls Mistral), and on completion transitions `awaiting_ocr -> assembling` (guarded CAS) and enqueues assembly (Task 6). Stale jobs past a deadline are failed and released. Tests drive the handler with a fake poller returning queued then completed. Commit.

### Task 6: Container `/assemble` and Worker finalize

Container `POST /assemble`: takes the batch results JSONL plus the page PNGs and sizes, runs `parse_ocr_reflow` per page and `build_doc`, returns verbatim JSON, `doc.json`, normalized Markdown, and figure assets. Worker finalize (invoked from the cron path): store verbatim + doc.json + md + figures in R2, `captureHold`, delete page PNGs, transition `assembling -> ready`; on failure failJob + releaseHold. Container tests use recorded results; Worker tests inject an assemble stub. Commit.

### Task 7: Container `/render` and Worker download route

Container `POST /render`: takes `doc.json`, figure assets, and `format` (epub|docx), returns the rendered bytes using the existing renderers. Worker `GET /api/jobs/:id/download?format=`: 404 unless the job is the caller's and `ready`; `md` streams `r2_md_key` directly; `epub`/`docx` fetch doc.json + figures, call `/render`, stream with a content-disposition filename from the job title (never an internal id, no vendor names in metadata). Tests inject a render stub and assert headers, ownership, and the not-ready 409. Commit.

### Task 8: Frontend, downloads and richer status

`cloud/frontend/app.js` + `index.html` + `ui.css`: on `ready` jobs show download buttons (EPUB, Markdown, Word) hitting the download route with the auth token (fetch + blob, since it needs the Bearer header); show `awaiting_ocr` as "In the OCR queue" and `assembling` as "Assembling your edition"; keep polling across the new states. Verify with the preview fixtures at 375 and 1280. Commit.

### Task 9: Deploy and real end to end

Deploy (container rebuild + cron + queue). Then, with a real signed-in session and admin-allocated credits: upload `Pareeksha Technologies.pdf` (17 pages, fast), watch it move received -> processing -> awaiting_ocr -> assembling -> ready, download the EPUB, render it to images and eyeball the recovered headings; repeat with the 152-page microbiome book to prove scale. Confirm the ledger shows one capture equal to pages x rate, the original PDF is gone from R2, and page PNGs are cleaned up. Screenshot the ready state. Update memory. Report results; fix real misfires.

## Not in this plan

Express (realtime) OCR variant, fixed-layout pipeline (ONNX LaMa), bulk and zip, email notifications, the 72h retention sweep as a separate cron (folded loosely here via delete-on-complete; a dedicated sweep for abandoned uploads comes later), ocrwithai.com is handled separately via the dashboard.
