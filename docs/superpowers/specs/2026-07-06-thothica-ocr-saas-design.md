# Thothica OCR: SaaS platform design

Date: 2026-07-06. Author: Adnan (design decisions) with Claude (drafting).
Status: approved in substance through design Q&A; open for redline.

## 1. Summary

Turn pdf2fxl into a white labeled SaaS at **ocrwithai.com**, branded **Thothica OCR**,
deployed entirely on Cloudflare. Users sign in with Google or email (Firebase Auth),
spend admin allocated credits to convert scanned PDFs through two pipelines:

- **Reflow**: scanned text book to reflowable EPUB, Markdown, DOCX. 0.7 credits per page.
- **Fixed layout**: picture book PDF to fixed layout EPUB3 and PPTX with LaMa
  inpainting. 3.0 credits per page.

All OCR goes through the Mistral **batch** endpoint by default (verified: batch
supports `/v1/ocr`, 50 percent discount, JSONL with `custom_id`, up to 1M requests).
An **express** option costs a flat **+0.2 credits per page** surcharge (0.9 reflow,
3.2 fixed) and runs the realtime endpoint immediately.

Users must never see Mistral, pdf2fxl, or any open source reference. Existing engine
code (`src/pdf2fxl/`) is reused as a library, untouched; its 82 fast tests keep passing.

## 2. Product identity and white labeling

- Name: **Thothica OCR**. Domain: **ocrwithai.com**. Branding: full Thothica
  (warm editorial, Cormorant Garamond + Teachers, brown/gold/cream, real ibis logo,
  sentence case, zero em or en dashes in any visible copy).
- No landing page in v1. Root routes to login (signed out) or dashboard (signed in).
  The login page must be genuinely attractive; it is the front door.
- White label rules, enforced everywhere a user can look: UI copy, emails, error
  messages, download filenames, EPUB/DOCX/PPTX metadata (generator: "Thothica OCR"),
  HTTP headers. Engine and vendor errors map to generic user safe messages; raw
  detail goes only to logs.

## 3. Users, auth, admin

- **Firebase Auth** on the client: Google sign in and **email magic link only**
  (passwordless; decided 2026-07-06 to avoid password reset and recovery
  workflows entirely). No password UI anywhere. The SPA sends the Firebase ID
  token as a Bearer header on every API call. Magic link sign ins arrive with
  email_verified true, which the API requires.
- Firebase project: `thothica-ocr` (created 2026-07-06). Email provider is set
  passwordless via the Identity Toolkit API; authorized domains include
  ocrwithai.com and the workers.dev host.
- The Worker verifies tokens against Google public JWKS (cached); no server SDK
  needed. First verified request upserts the D1 user row.
- **adnan@thothica.com is admin** (seeded). Admin capability is a D1 flag
  (`is_admin`) so more admins can be added later. Admin can: list users, allocate
  or revoke credits with a note, see all jobs and usage.
- New accounts start at **zero credits** (no trial). Users obtain credits only by
  admin allocation. Payments (Razorpay) are explicitly out of scope for v1.
- Open item: Firebase CLI credentials on this machine are expired. Design assumes a
  standard Firebase project; real web app config is wired in once Adnan runs
  `firebase login --reauth` (or provides the project id).

## 4. Pricing and credits

Rates are configuration (D1 table), not code. One price per pipeline, no tiers:

| Pipeline | Credits/page |
|---|---|
| Reflow | 0.9 |
| Fixed layout | 3.0 |

Decided 2026-07-06: the batch-versus-express distinction is removed. The Mistral
batch OCR endpoint does not return the bounding boxes the reflow geometry needs
(verified against the live API), so all OCR runs on the realtime endpoint. That is
an implementation detail; users never see "batch", "express", or "realtime". Reflow
moved from 0.7 to 0.9 to cover the realtime processing; fixed layout stays at 3.0
(already priced high). No express surcharge.

**Ledger semantics.** The credit ledger is append only; a user's balance is the sum
of their rows. Row kinds:

- `allocation` (admin grant or revoke, signed, with note and created_by)
- `hold` (negative, placed when page count is known, before OCR is submitted)
- `capture` (converts a hold into a final charge when outputs are delivered)
- `release` (refunds a hold when a job fails or is cancelled)

**Charging rule (Adnan's):** credits are debited only when the result exists.
Reserve at submission, capture on delivery, release on failure (for example a
Mistral outage). Race conditions are handled structurally:

- Hold placement is a single D1 transaction: balance check and hold insert together;
  insufficient balance fails the job before any OCR cost.
- Job status transitions use conditional updates (`UPDATE ... WHERE status = ?`);
  a job cannot finalize twice, a hold cannot both capture and release.
- Cron sweeps release holds on jobs stuck past a deadline (48h after OCR submission)
  and marks them failed.

## 5. Architecture (all Cloudflare)

Chosen approach: everything on Cloudflare, Python engine in Cloudflare Containers.
R2 is the backbone.

- **Worker** (TypeScript, Hono): API front door, Firebase token verification,
  credits and jobs endpoints, admin endpoints, signed downloads, serves the static
  frontend via Workers Assets.
- **D1**: users, jobs, ledger, config (schema in section 8).
- **R2**: all files (layout in section 6). Lifecycle rules enforce retention.
- **Queues**: job dispatch from Worker to container.
- **Container** (Python, via Durable Object binding): wraps the pdf2fxl engine.
  Rasterizes, counts pages, builds and submits Mistral batch JSONL, runs the reflow
  or fixed layout pipeline on OCR results, writes artifacts to R2, renders outputs
  on demand. LaMa runs as ONNX (no torch) to keep the image small; if container
  image limits still bite, the fallback (pre agreed) is moving only this service to
  an external host.
- **Cron Worker**: polls Mistral batch status, triggers finalization, sweeps the
  72h deletion rule and stale holds.
- **Email**: Cloudflare Email Service. "Your documents are ready" and failure
  notices, linking to the dashboard. No vendor names.

Secrets (`MISTRAL_API_KEY`) live in Worker/container secrets, never in the repo.

## 6. Data and artifacts (R2)

**Core principle (Adnan's): rendered outputs are not stored.** EPUB, Markdown file
downloads, DOCX, PPTX are deterministic renders over light canonical artifacts and
are generated on demand at download time. What is stored, per job:

- `uploads/{userId}/{jobId}.pdf`: the original. Only needed until `preparing`
  completes (rasterization happens within minutes of upload). Deleted explicitly
  when the job completes; an R2 lifecycle rule on the prefix guarantees deletion
  within **72 hours** of upload regardless. Because OCR runs on the rasterized
  page images, a slow batch cannot be broken by this deletion.
- `pages/{jobId}/p{n}.png` (all jobs): rasterized page images. These feed OCR and
  the ink row type size measurement, so they must live until `assembling`
  completes. For reflow jobs they are deleted at job completion (7 day lifecycle
  backstop). For fixed layout jobs the inpainted versions are kept (next bullet).
- `ocr/{jobId}/verbatim.json`: the **verbatim Mistral OCR response**, exactly as
  returned, page keyed by `custom_id`. Never shown to users. Kept long term.
- `doc/{jobId}/normalized.json`: the normalized `Doc` model (the engine's JSON
  serializable document: heading hierarchy resolved book globally, layout
  normalized). This is the render source for all reflow outputs.
- `doc/{jobId}/normalized.md`: the normalized Markdown rendering, stored because it
  is tiny and is the human readable canonical text.
- Fixed layout jobs additionally store `pages/{jobId}/inpainted-p{n}.png` and
  `pages/{jobId}/layout.json` (per page block JSON): these are the irreducible
  sources for regenerating fixed layout EPUB/PPTX after the original PDF is gone.
  Assembly into EPUB/PPTX happens on demand.
- `renders/{jobId}/...`: optional short lived cache of generated outputs with a 7
  day lifecycle; purely a cache, always regenerable, never the source of truth.

**Heading normalization happens at OCR to Markdown time** (the existing reflow
hierarchy step). Both artifacts are saved with a **first class relationship**:
same `jobId`, page level `custom_id` alignment, and D1 columns recording both R2
keys plus `engine_version` and `schema_version`. Purpose (Adnan's): verbatim to
normalized pairs are future model training data; the pairing must be trivially
extractable.

## 7. Job lifecycle

States: `received` > `preparing` (rasterize, count pages, hold credits) >
`awaiting_ocr` (batch submitted) or `processing` (express) > `assembling`
(pipeline + artifact write) > `ready`, or `failed` (with plain English reason,
hold released).

- **Default (batch):** upload > container counts pages and places hold > JSONL
  built (custom_id = `{jobId}:{page}`) > Mistral batch submitted > cron polls >
  on completion container runs the pipeline, writes artifacts, captures credits,
  emails the user.
- **Express:** same flow but the container calls the realtime OCR endpoint
  immediately and streams per page progress to the UI (like the current console).
- **Bulk:** multi select PDFs or a single zip (container unpacks). Each file
  becomes its own job under a shared `bulk_id` with one settings panel. All pages
  of a bulk group ride one batch submission. Downloads: per file, or everything as
  a zip (assembled on demand). Credits: one hold per job so a single oversized file
  fails alone, not the whole batch.
- **Downloads:** Worker checks `ready`, asks the container to render (or serves the
  render cache), streams from R2 with a signed, time limited URL. Filenames carry
  the user's title, never internal names.

## 8. D1 schema (essentials)

- `users`: uid (Firebase), email, name, is_admin, created_at.
- `credit_ledger`: id, user_id, kind (allocation/hold/capture/release), amount
  (signed), job_id nullable, note, created_by, created_at. Balance = SUM(amount).
- `jobs`: id, user_id, bulk_id nullable, mode (reflow/fixed), express bool,
  status, page_count, rate_per_page, hold_id, batch_id nullable, r2 keys
  (upload, verbatim, doc, md, pages prefix), engine_version, schema_version,
  error_public, error_internal, timestamps per transition.
- `config`: key/value (rates, retention hours, express surcharge).

## 9. Frontend

Static SPA served by the Worker, porting the existing console's Thothica design
language. Pages:

1. **Login**: editorial, brand signature piece. Google button + email form.
2. **Dashboard**: credit balance, job list with live statuses, bulk groups.
3. **New job**: today's upload panel extended: mode picker (reflow / fixed layout),
   express toggle showing the price difference, multi file and zip drop, title,
   layout and format options, credit cost preview (pages x rate, shown after
   preparing).
4. **Job detail**: recovered table of contents preview (reflow), download buttons
   per format, status timeline.
5. **Admin** (admin only): users table, allocate/revoke credits with note, usage
   and job overview.

Responsive from 360px mobile to ultra wide; padding and type scale audited at
mobile and laptop breakpoints as an explicit acceptance gate. Brand rules apply
(zero em/en dashes; lint visible copy).

## 10. Testing and verification

- Engine: untouched; existing fast suite stays green.
- Worker: vitest + miniflare. Heaviest coverage on ledger concurrency
  (hold/capture/release, double finalize, insufficient balance) and auth
  middleware (expired/forged tokens).
- Container: pytest against mocked Mistral (batch submit, poll, results,
  failure paths), artifact writes to a fake R2.
- End to end gate before "done" (house rule, non negotiable): deployed to
  Cloudflare, one real scanned PDF through batch reflow, one through express, one
  fixed layout book; download and eyeball the EPUBs rendered to images; UI
  screenshots at mobile and laptop widths; login with both Google and email.

## 11. Deployment

- Repo layout: `cloud/worker/` (TS), `cloud/container/` (Python service +
  Dockerfile), `cloud/frontend/` (static assets). Wrangler config committed.
- `wrangler deploy` for Worker + assets + cron; wrangler builds and pushes the
  container image. D1 migrations via wrangler d1.
- Custom domain ocrwithai.com attached in Cloudflare (verify the zone exists in
  the account; if not, Adnan adds it).
- Open items: Firebase reauth (section 3); wrangler token may need a fresh
  `wrangler login` for D1/R2/Queues/Containers scopes.

## 12. Phases

1. Platform skeleton: worker, D1 schema + migrations, Firebase auth verify,
   static shell deployed to workers.dev.
2. Credits ledger + admin allocation (API + tests).
3. Express reflow end to end: upload, prepare, hold, realtime OCR, artifacts,
   on demand render, download.
4. Batch pipeline: JSONL, submit, cron poll, finalize, email.
5. Fixed layout pipeline (ONNX LaMa) with stored page assets.
6. Bulk: multi file, zip in, zip out, group UX.
7. Admin panel UI + white label audit.
8. Retention sweeps, polish, full visual gate, custom domain cutover.

## 13. Out of scope (v1)

Landing page, self serve payments (Razorpay later), trial credits, public launch,
PPTX font embedding, team/org accounts.
