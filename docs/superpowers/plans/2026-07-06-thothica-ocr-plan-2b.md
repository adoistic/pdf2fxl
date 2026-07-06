# Thothica OCR SaaS, plan 2b of N: the OCR loop (batch pipeline, artifacts, downloads)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A reflow job runs end to end: upload, submit every page to the Mistral batch OCR endpoint, poll to completion on a cron, assemble the normalized document, store the light artifacts, capture credits, and let the user download a reflowable EPUB, Markdown, and DOCX. This is the piece that makes the product actually produce output.

**Why realtime, settled by the spike (2026-07-06):** the Mistral batch endpoint is 50 percent cheaper but its server-side OCR schema rejects `include_blocks` (proven: batch upload 422 `body.OCRRequest.include_blocks Extra inputs are not permitted`), so batch returns markdown with no bounding boxes. The reflow algorithm recovers heading levels from block geometry, so it requires the boxes, which only the realtime `ocr.process(..., include_blocks=True)` returns. Adnan chose to keep the geometry (his differentiator) over the batch discount; the cost delta is a few cents per book. Realtime is parallelized inside the container (async concurrency ~8-12), so a 200-page book finishes in well under a minute. This also removes the batch submit, the cron poller, and the intermediate page storage: the whole OCR plus assembly happens in one container call.

**Architecture (async via a queue, three moving parts):**
1. On start (hold already placed in plan 2a): the Worker moves the job to `processing`, enqueues `{jobId}` on an OCR queue, and returns immediately so the UI can poll. The original upload stays in R2 until the job finishes.
2. A **queue consumer** (in the same Worker, up to 15 min wall time) pulls each job, streams the PDF from R2 to the container `POST /process` with the Mistral key, and awaits the artifacts. The container rasterizes and trims every page, OCRs them concurrently with realtime `include_blocks`, runs the existing reflow assembly (`parse_ocr_reflow` + `build_doc`), and returns the verbatim OCR JSON, the normalized `doc.json`, the normalized Markdown, and any figure crop assets. The Worker stores verbatim + doc.json + md + figures in R2, captures the hold, deletes the original upload, and marks the job `ready`. On any failure: failJob + releaseHold, upload kept for retry.
3. **Downloads**: `GET /api/jobs/:id/download?format=epub|md|docx` fetches `doc.json` and figure assets from R2, asks the container `POST /render` for that format, and streams the file. Markdown is served directly from R2; EPUB and DOCX are rendered on demand (deterministic, not stored).

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

### Task 2: Artifact columns

The 0002 jobs table already has `r2_verbatim_key`, `r2_doc_key`, `r2_md_key`. Migration `0003_artifacts.sql` adds `r2_figures_prefix TEXT` and `finished_at TEXT`. Tests assert the columns exist and default null. No new states are needed: realtime processing is a single `processing -> ready` (or `failed`) transition, both already in the 0002 CHECK. Commit.

### Task 3: Container `/process` endpoint (rasterize, parallel realtime OCR, assemble)

`cloud/container/app.py`: add `POST /process` taking the PDF bytes, `mode`, `title`, and the Mistral key (header `x-mistral-key`). It rasterizes and trims every page, OCRs them concurrently (realtime `ocr.process` with `include_blocks=True`, model `mistral-ocr-latest`, an asyncio/thread pool of ~10) into per-page responses, then runs the existing reflow assembly (`parse_ocr_reflow` per page, `build_doc`). Returns JSON: `{ verbatim: [...per page raw...], doc_json: {...}, markdown: "...", figures: [{name, base64}] }`. Reuses the engine end to end via `convert_book_reflow`'s building blocks; the injected OCR function is the realtime parallel caller. pytest against a 3-page synthetic PDF with the Mistral client mocked to return recorded block responses; assert doc_json has the expected heading levels and markdown is non-empty. Commit.

### Task 4: Queue binding, producer on start, consumer that finalizes

Add a Queue (`ocr-jobs`) to wrangler.jsonc (producer + consumer). Extend `startJob` (src/start.ts): after the hold and `processing` transition, enqueue `{ jobId }`. Add the `queue()` handler: for each message, load the job, stream its PDF from R2 to container `/process`, store `verbatim` at `ocr/{jobId}/verbatim.json`, `doc_json` at `doc/{jobId}/normalized.json`, `markdown` at `doc/{jobId}/normalized.md`, figures under `doc/{jobId}/figures/`, set the r2 keys on the job, `captureHold`, delete the original upload, transition `processing -> ready`. On any error: failJob + releaseHold (keep upload), and let the queue retry policy apply. The container call is injected in tests (a `processFn` stub, mirroring the existing `EnginePrepare` injection) so no container or Mistral is needed; assert artifacts land in R2, the hold captures, the job is `ready`, and the failure path releases. Commit.

### Task 5: Container `/render` and Worker download route

Container `POST /render`: takes `doc.json`, figure assets, and `format` (epub|docx), returns the rendered bytes using the existing renderers. Worker `GET /api/jobs/:id/download?format=`: 404 unless the job is the caller's and `ready`; `md` streams the stored markdown directly; `epub`/`docx` fetch doc.json + figures, call `/render`, stream with a content-disposition filename from the job title (never an internal id, no vendor names in metadata). Tests inject a render stub and assert headers, ownership, and the not-ready 409. Commit.

### Task 5.5: Remove the express tier, reprice reflow (backend)

Single-tier pricing (Adnan, 2026-07-06). Migration `0004_pricing.sql` already sets
`rate_reflow_mcr=900` and `express_surcharge_mcr=0`. In `src/start.ts` simplify
`rateFor` to just the per-mode rate with no express surcharge, and stop reading the
`express` flag for pricing (reflow 0.9, fixed 3.0). Update `test/start.test.ts`:
reflow is 900/page, fixed 3000/page, drop the express cases. The `express` job
column stays (harmless, always 0) to avoid a migration churn. Apply 0004 to remote
D1 at deploy. Commit.

### Task 6: Frontend, downloads, and single-tier pricing

`cloud/frontend/app.js` + `index.html` + `ui.css`: (a) REMOVE the Express toggle
entirely and any batch/express/realtime wording; the upload panel offers only the
two editions with one price each, reflow 0.9 credits/page and fixed 3.0. Stop
sending the `express` query param. (b) On `ready` jobs show download buttons (EPUB,
Markdown, Word) hitting the download route with the auth token (fetch + blob, since
it needs the Bearer header). Keep the friendly `processing` label ("Reading your
pages") across the longer OCR run; keep polling. Never expose OCR mechanics. Verify
with the preview fixtures at 375 and 1280. Commit.

### Task 7: Deploy and real end to end

Deploy (container rebuild + queue). Then, with a real signed-in session and admin-allocated credits: upload `Pareeksha Technologies.pdf` (17 pages, fast), watch it move received -> processing -> ready, download the EPUB, render it to images and eyeball the recovered headings; repeat with the 152-page microbiome book to prove scale. Confirm the ledger shows one capture equal to pages x rate and the original PDF is gone from R2. Screenshot the ready state. Update memory. Report results; fix real misfires.

## Not in this plan

The cheaper batch path (blocked: Mistral batch OCR omits bounding boxes), fixed-layout pipeline (ONNX LaMa), bulk and zip, email notifications, the 72h retention sweep as a separate cron (folded loosely here via delete-on-complete; a dedicated sweep for abandoned uploads comes later). ocrwithai.com is handled separately via the dashboard.
