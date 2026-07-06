# Bulk upload v2: upfront page-wise credit gate, remaining indicator, 10-wide

**Goal (Adnan):** upload any number of PDFs at once; process ~10 concurrently; a UI
that shows how many are left; and credits deducted page-wise UPFRONT so a user can
never commit more pages than they can afford (no discovering it mid-batch).

**The gap today:** each file uploads then immediately `/start`s (counts pages, places
a hold, enqueues). On a 402 the front end stops launching new files, so a user learns
they are short only partway through, and some books are already charged. Processing is
also effectively serial (container max_instances 1, queue batch 1).

## Design: two phases with a gate between

**Phase A, upload + count (no charge).** Upload every file to R2 (jobs land in
`received`, sharing a `bulkId`). Then count pages per job via a new
`POST /api/jobs/:id/count` that runs the container `/prepare`, stores `page_count`
and `rate_mcr` on the job, and places NO hold. The front end sums pages as counts
arrive, showing "counting X of N".

**Gate.** total credits needed = sum(pages) x rate. Fetch balance from `/api/me`.
- needed <= balance: enable "Process N books (P pages, C credits)".
- needed > balance: block, show the shortfall ("this batch needs C credits, you have
  B; remove some books or add credits"), and offer "process what fits" which starts
  books in order until the balance is used up. The user is never silently over-charged.

**Phase B, start.** For each book to process, `POST /api/jobs/:id/start`. `startJob`
now REUSES the stored `page_count` (skips a second `/prepare`), places the hold
(atomic balance check still the real guard), and enqueues. Because the total was
checked, holds fit; the atomic hold remains the backstop against races.

**Concurrency ~10.** Front end bounded concurrency 3 -> 10 across upload/count/start.
Queue consumer `max_concurrency: 10`; container `max_instances: 10` so up to ten books
OCR at once and the queue holds the rest (the "10, 10, 10" batching falls out of the
queue naturally). Each book is ~1GB at 150 DPI, so ten instances are well within limits.

**Remaining indicator.** A bulk panel that walks the phases: "Counting pages X/N" ->
"N books, P pages, C credits (you have B)" with the process/adjust choice -> during
processing "Processed X of N, Y remaining", driven by polling the jobs list.

## Tasks

1. Worker: `recordCount` (UPDATE page_count+rate_mcr WHERE received & page_count null),
   `countJob` (count via injected prepare, no hold), route `POST /api/jobs/:id/count`.
   `startJob` reuses a stored `page_count`. Tests: count stores + no hold + idempotent;
   start reuses the count (prepare not called when page_count present). No charge on count.
2. Config: queue `max_concurrency: 10`, container `max_instances: 10`, front end
   `BULK_CONCURRENCY = 10`.
3. Frontend: two-phase bulk (upload -> count-all -> gate -> start-affordable), the
   remaining indicator, and the affordability copy. Brand + responsive; verify at 375
   and 1280 with preview fixtures.
4. Deploy (container rebuild + config), verify container ready, smoke test.

Single-file upload keeps its current one-step flow (count folded into start).

## Out of scope

Per-user (vs global) concurrency fairness, a server-side zip download, resumable bulk.
