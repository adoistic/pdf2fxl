# Emphasis enrichment add-on — design

**Date:** 2026-07-07
**Author:** Adnan
**Status:** Approved (design), pending spec review

## 1. Summary

Mistral OCR returns the words on a page but not their **bold / *italic* / <u>underline</u>**
styling. This feature adds an opt-in **add-on** that, after normal OCR, runs one extra
vision pass per page against a configurable OpenRouter model to recover that styling and
apply it to the output.

It is **not a new mode**. It is a flag orthogonal to the existing Reflowable / Fixed
modes, priced at **+0.2 credits per page** on top of the mode's base rate, and it can be
enabled with either mode.

The pass shows the model the page image plus the document's own paragraph text and asks
it to return that text verbatim with `<b>` / `<i>` / `<u>` tags wrapped around emphasized
spans. An integrity gate guarantees the model can only *add tags*, never change words, so
the feature can never corrupt a user's document.

## 2. Goals / Non-goals

**Goals**

- Recover bold, italic, and underline emphasis at the word/phrase level within body
  paragraphs, for both Reflowable and Fixed modes.
- Charge exactly +0.2 credits/page, gated **up front** (part of the bulk credit gate) so a
  user can never commit more pages than they can afford — consistent with the existing
  count/gate flow.
- Never ship altered text. If the pass fails or the model deviates from the OCR text, fall
  back to plain output and refund the surcharge for the affected pages.
- Keep the OCR engine (`src/pdf2fxl`) import-only except for one minimal, additive change
  required to represent underline.

**Non-goals (v1)**

- Emphasis inside tables, formulas, figure captions, or headings (headings are already
  bold by level; tables are already HTML).
- Any change to how base OCR, layout, or heading recovery works.
- Superscript/subscript, small-caps, color, font-family detection.
- Per-user concurrency fairness changes (unchanged from today).

## 3. User-facing behavior

**Upload form.** Below the mode radios (`.modes` fieldset in `index.html`) add one
checkbox, shown only when the add-on is configured (see §10):

> ☐ Detect **bold**, *italic* & underline — +0.2 credits per page

It applies to whichever mode is selected. It is a single control for both single-file and
bulk uploads (the flag rides on every job created in that submission).

**Pricing display & gate.** The bulk credit gate already computes `rate × pages` per book
and sums them. Because the surcharge is folded into the per-page rate the Worker returns
from the count endpoint, the gate total, the "credits needed", and the "process what fits"
math all account for the surcharge automatically — no gate UI logic changes beyond the
number it already shows.

**Result.** Bold/italic/underline appear in the EPUB and DOCX. Markdown has no underline
syntax, so `.md` keeps bold/italic and silently drops underline (documented, expected).

## 4. Data model changes

New migration `0005_enrich.sql`:

```sql
-- Emphasis enrichment add-on (+0.2 credits/page). Orthogonal to mode.
ALTER TABLE jobs ADD COLUMN enrich INTEGER NOT NULL DEFAULT 0;
-- Per-page surcharge, snapshotted at count/start time so the hold and any
-- later refund always agree even if the config rate changes between them.
-- NULL until the job is counted; 0 when the add-on is off.
ALTER TABLE jobs ADD COLUMN enrich_rate_mcr INTEGER;

-- Surcharge rate and the OpenRouter model id (admin-editable without a redeploy).
-- enrich_model is an empty string until the admin sets it; an empty model
-- disables the add-on end to end (see §10).
INSERT INTO config (key, value) VALUES ('rate_enrich_mcr', '200');
INSERT INTO config (key, value) VALUES ('enrich_model', '');
```

The dead `express` column is left untouched.

`Job` type gains `enrich: boolean` and `enrichRateMcr: number | null`; the row mapper and
`createJob` are extended accordingly.

## 5. Pricing, hold, and refund (money path)

**Rate.** A single helper computes the total per-page rate used by both count and start:

```
totalRateMcr(db, mode, enrich) = rateFor(mode) + (enrich ? rate_enrich_mcr : 0)
```

`rateFor` is unchanged (base mode rate). The surcharge is a separate config value so it is
never conflated with the base rate.

**Count (no charge).** `countJob` reads `job.enrich`, computes `enrichRateMcr =
enrich ? rate_enrich_mcr : 0`, stores **both** `rate_mcr` (base) and `enrich_rate_mcr`
(surcharge snapshot) on the job, and returns `creditsMcr = (rate_mcr + enrich_rate_mcr) ×
pages`. The bulk gate sees the surcharge with no further change.

**Start (hold).** The hold amount becomes `(rate_mcr + enrich_rate_mcr) × pages`. `rateFor`
is replaced by the total helper. When start counts pages itself (single-file path that
skips a prior count), it snapshots `enrich_rate_mcr` in the same `transition` that records
`rate_mcr`.

**Finalize (capture + per-page refund).** The container returns an enrichment summary
(§6). At finalize, after the artifact UPDATE succeeds and `captureHold` runs (both
unchanged), we post one **idempotent** refund for pages that did not get the pass:

```
refundMcr = enrich_rate_mcr × (page_count − pages_enriched)
```

- If the add-on was off (`enrich_rate_mcr = 0`) → `refundMcr = 0`, no row.
- If every page was enriched → `refundMcr = 0`, no row.
- If the whole book fell back (`pages_enriched = 0`) → the entire surcharge is refunded
  (exactly the "deliver plain, refund" case).
- Partial → the user keeps emphasis on the pages that succeeded and is refunded for the
  rest.

A page counts as **enriched** (surcharge earned) when its pass completed and the integrity
gate held — whether or not any emphasis was found (the detection service was rendered). A
page counts as **not enriched** (refunded) only when the pass errored or the gate rejected
its result and we shipped that page plain.

**Refund representation.** The ledger `kind` CHECK allows only
`allocation/hold/capture/release`, and rebuilding the live money table to add a `refund`
kind is not worth the risk. The refund is therefore a positive **`allocation`** row with
`created_by = 'system'` and a descriptive note (`emphasis surcharge refund: N/M pages`),
which satisfies the sign/magnitude CHECK and keeps the balance = SUM(amount_mcr) invariant.
Admin allocations are distinguishable by their `created_by` (an admin email) and note.

**Idempotency.** Finalize can be retried (queue redelivery re-runs the whole container
process). The refund insert is guarded so at most one system refund exists per job:

```sql
INSERT INTO credit_ledger (user_id, kind, amount_mcr, job_id, note, created_by)
SELECT ?userId, 'allocation', ?refundMcr, ?jobId, ?note, 'system'
WHERE ?refundMcr > 0
  AND NOT EXISTS (
    SELECT 1 FROM credit_ledger
    WHERE job_id = ?jobId AND kind = 'allocation' AND created_by = 'system'
  );
```

This is robust to a crash anywhere around capture (unlike gating on the first capture,
which loses the refund if a crash lands between capture and the refund insert). If two
retries compute slightly different `pages_enriched` (the pass is re-run), only the first
insert persists; the difference is within noise and the invariant holds.

## 6. Container enrichment pass

Runs inside `/process`, after `convert_book_reflow` builds `doc.json`, before the response
is assembled. Gated on `?enrich=1` **and** a non-empty model + present OpenRouter key;
otherwise it is a no-op that reports `pages_enriched = 0`.

Inputs already on hand in `/process`: `verbatim` (per-page raw OCR, incl. block text), the
built `Doc`, the PDF path (so pages can be re-rasterized on demand), and `cfg`.

**Algorithm**

1. **Bucket paragraphs to pages.** Extract each page's plain text from `verbatim[i]`. Walk
   the Doc's `Paragraph` nodes in reading order with a **monotonic** page cursor, assigning
   each paragraph to the adjacent page (current / current+1 lookahead) with the higher
   word-overlap. Bucketing errors only reduce recall — a paragraph shown the wrong page
   image simply won't have its styling found — they can never corrupt text.

2. **Per page, one OpenRouter call (concurrent, reusing the `_OCR_CONCURRENCY` pool).**
   Re-rasterize the page (`rasterize_page` + `_trim`, one image at a time to bound memory),
   PNG-encode it, and send: the image + a JSON array of that page's paragraph texts + the
   configured instruction. Expected response: a JSON array of the same length, each element
   the corresponding input string with `<b>`/`<i>`/`<u>` tags added and nothing else
   changed. Retry on transient errors (bounded); on final failure the page's paragraphs are
   left plain.

3. **Per-paragraph integrity gate.** For each returned element: parse only `<b>/<i>/<u>`
   (and `<strong>/<em>` synonyms), strip the tags, normalize whitespace, and require exact
   equality with the input paragraph text. On any mismatch, array-length mismatch, or parse
   error, that paragraph is left plain and does not count as enriched.

4. **Split runs.** For each paragraph that passed, replace its single `Run` with a sequence
   of `Run`s carrying `bold` / `italic` / `underline` per the tagged spans. Whitespace and
   full text are preserved by construction (guaranteed by step 3).

5. **Summary.** Track, across the book, `pages_total` and `pages_enriched` (a page is
   enriched iff the pass completed and **every** paragraph bucketed to it passed the gate; a
   page with any failed paragraph or an API failure is not enriched → refunded). Return:

   ```json
   "enrich": { "requested": true, "pages_total": N, "pages_enriched": K }
   ```

   When `?enrich=1` is absent or the add-on is unconfigured: `{ "requested": false,
   "pages_total": N, "pages_enriched": 0 }` — finalize treats `enrich_rate_mcr = 0`, so this
   yields no refund and no charge regardless.

**OpenRouter client.** A small helper using `httpx` (already a dependency), POSTing to the
chat-completions endpoint with a vision message (image as a data URL + text). Model id
comes from the request (Worker passes the config value); the API key comes from the
`x-openrouter-key` header (never logged). Timeout and a bounded retry mirror the OCR path.

**Note on page granularity for "enriched".** Defining a page as enriched only when *all*
its paragraphs pass keeps the summary a clean per-page count that finalize can bill against
`page_count`. A single stubborn paragraph refunds that one page — conservative in the
user's favor.

## 7. Engine change (underline) — minimal, additive

The only change to `src/pdf2fxl`:

- `docmodel.py`: add `underline: bool = False` to `Run`. `asdict`/`from_json` carry it
  automatically; old `doc.json` without the field defaults to `False` (backward compatible).
- `render_epub_reflow.py`: after the bold/italic wrap, `if r.underline: t = f"<u>{t}</u>"`.
- `render_docx.py`: `run.underline = r.underline`.
- `render_md.py`: no change — Markdown cannot express underline; bold/italic still emit.

Bold and italic require **no** engine change: `Run.bold`/`Run.italic` already render as
`<strong>`/`<em>` (EPUB) and real bold/italic (DOCX), and every renderer already loops over
multiple runs per paragraph. Splitting one run into several is fully supported today.

## 8. Worker plumbing

- **`routes/jobs.ts` `POST /`**: read `enrich` from query (`?enrich=1`); pass to `createJob`.
  Reject `enrich=1` with a clear 409 when the add-on is unconfigured (empty `enrich_model`
  or missing OpenRouter secret), so the box never silently no-ops.
- **`jobs.ts`**: `Job` gains `enrich`, `enrichRateMcr`; row mapper, `SELECT_COLS`,
  `createJob`, and the `TRANSITION_COLS` whitelist (`enrich_rate_mcr`) updated.
- **`start.ts`**: `rateFor` → `totalRateMcr(db, mode, enrich)`; `countJob` and `startJob`
  snapshot `enrich_rate_mcr`; `recordCount` writes it alongside `rate_mcr`.
- **`finalize.ts`**: `realProcess` adds `enrich=1` and the model id to the `/process` query
  and forwards `x-openrouter-key`; after capture, post the idempotent refund from
  `out.enrich`. `FinalizeRow`/`toJob` read the new columns.
- **`config` surface**: extend the existing session/bootstrap response (the endpoint the
  SPA already calls for the signed-in user) with `enrichAvailable: boolean` and
  `enrichRateCredits: 0.2` so the frontend can show the checkbox and its price.

## 9. Frontend plumbing (`index.html`, `app.js`, `ui.css`)

- Add the checkbox to the upload form, hidden unless `enrichAvailable`.
- `createAndUpload` / job-create calls append `&enrich=1` when checked (both single and
  bulk paths).
- The processing indicator and gate copy are unchanged; only the numbers move.
- Minor styling to match the existing `.mode` controls.

## 10. Configuration & secrets (inputs required from Adnan)

- **`OPENROUTER_API_KEY`** — a Worker secret (`wrangler secret put`), forwarded to the
  container as `x-openrouter-key`. Never logged, never returned.
- **`enrich_model`** — the OpenRouter model id, stored in the D1 `config` table so it can be
  changed without a redeploy. Empty by default → add-on disabled.
- **Instruction/prompt** — the exact wording ("check this page for bold/italic/underline
  and wrap them in HTML tags, return the text verbatim otherwise…") is versioned as a
  reviewed constant in the container so it is testable and diffable. Placeholder until
  provided.

`enrichAvailable` is true iff `enrich_model` is non-empty **and** the OpenRouter secret is
present. Until both are set, the checkbox is hidden and `enrich=1` is rejected — the feature
ships dark and lights up when Adnan sets the two values.

## 11. Failure modes & safety invariants

- **Model alters/drops text** → integrity gate rejects that paragraph → shipped plain →
  page refunded. *Text is never corrupted.*
- **OpenRouter down / key missing / model empty** → pass no-ops → `pages_enriched = 0` →
  full surcharge refunded → user gets normal OCR at base price.
- **Partial page failures** → per-page refund; emphasis kept where it succeeded.
- **Finalize retry / crash windows** → capture is idempotent (existing settlement index);
  refund is idempotent via the `NOT EXISTS` guard.
- **Config rate changes mid-flight** → hold and refund both use the `enrich_rate_mcr`
  snapshotted on the job, so they always agree.
- **Bucketing error** → reduced recall only, never corruption.
- **Base OCR is unaffected** — the pass runs after `doc.json` is built and only mutates run
  styling; if it throws unexpectedly it is caught and the book ships plain (fail-open on the
  add-on, never on the document).

## 12. Testing plan

**Container (pytest, stubbed OpenRouter — no network/key):**
- Tag-splitting: a paragraph with `<b>`/`<i>`/`<u>` becomes the right sequence of styled
  `Run`s; combined nesting works.
- Integrity gate: a stub that changes a word, drops a word, or returns the wrong array
  length → paragraph left plain, page not counted enriched.
- No-op paths: `enrich` absent, empty model, missing key → `requested`/`pages_enriched`
  correct, `doc.json` unchanged.
- Bucketing: paragraphs assigned to the right pages on a two-page fixture.
- Underline round-trips through EPUB (`<u>`) and DOCX (`run.underline`).

**Worker (vitest):**
- `countJob` folds the surcharge into `creditsMcr` and snapshots `enrich_rate_mcr`; base
  case unchanged when `enrich=0`.
- `startJob` holds `(base+surcharge)×pages`; insufficient-credit gate accounts for it.
- `finalize` posts the correct per-page refund for full / partial / none-enriched, and is
  idempotent across a second finalize (no double refund).
- `POST /` rejects `enrich=1` when unconfigured; accepts and persists the flag when
  configured.

**Adversarial review** of the spec and the money path before/around build.

## 13. Rollout / deploy

1. Migration `0005_enrich.sql` applied to D1 (remote).
2. Container rebuilt (new enrichment module + engine underline change) and deployed.
3. Worker deployed with the new routes/pricing/refund.
4. Ships **dark**: `enrich_model` empty, no OpenRouter secret → checkbox hidden, behavior
   identical to today.
5. Adnan sets `OPENROUTER_API_KEY` and `enrich_model`, supplies the prompt wording → the
   add-on lights up. A live end-to-end test on a small styled PDF confirms emphasis and the
   correct charge/refund.

## 14. Open questions / future

- Exact OpenRouter model + prompt wording (Adnan to provide; placeholders until then).
- Possible future: emphasis in headings/captions; superscript/subscript; a confidence
  threshold that only applies emphasis above some model-reported certainty.
- Possible future: surface "N pages enriched" in the job's UI detail so the user sees what
  the surcharge bought.
