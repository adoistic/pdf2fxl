# Emphasis enrichment add-on — design

**Date:** 2026-07-07
**Author:** Adnan
**Status:** Approved (design) · tightened after adversarial review (2026-07-07)

## 1. Summary

Mistral OCR returns the words on a page but not their **bold / *italic* / <u>underline</u>**
styling. This feature adds an opt-in **add-on** that, after normal OCR, runs one extra
vision pass per page against a configurable OpenRouter model to recover that styling and
apply it to the output.

It is **not a new mode**. It is a flag orthogonal to the existing Reflowable / Fixed modes,
priced at **+0.2 credits per page** on top of the mode's base rate, enabled with either
mode.

**The safety invariant that governs the whole design:** the rendered text is *always* the
document's own original text. The model's output is used **only** to decide which character
ranges are bold/italic/underlined — not one character of model output ever reaches the
document. Emphasis can only be *added* on top of existing styling, never removed, and text
can never be altered.

## 2. Goals / Non-goals

**Goals**

- Recover bold, italic, and underline emphasis at the word/phrase level within body
  paragraphs, for both Reflowable and Fixed modes.
- Charge exactly +0.2 credits/page, gated **up front** (part of the bulk credit gate) so a
  user can never commit more pages than they can afford.
- Never ship altered text. If the pass fails or the model deviates from the OCR text, fall
  back to plain output and refund the surcharge for the affected pages.
- Keep the OCR engine (`src/pdf2fxl`) import-only except for one minimal, additive change
  required to represent underline.

**Non-goals (v1)**

- Emphasis inside tables, formulas, figure captions, or headings.
- Any change to base OCR, layout, heading recovery, or paragraph assembly.
- Superscript/subscript, small-caps, color, font-family detection.

## 3. User-facing behavior

**Upload form.** Below the mode radios add one checkbox, shown only when the add-on is
configured (§10): *"Detect **bold**, *italic* & underline — +0.2 credits per page."* It
applies to whichever mode is selected and to every job in the submission (single or bulk).

**Pricing & gate.** The surcharge is folded into the per-page cost the count endpoint
returns, so the existing bulk gate's "credits needed", per-book totals, and "process what
fits" math all account for it with no gate-logic change — only the numbers move.

**Result.** Bold/italic/underline appear in EPUB and DOCX. Markdown has no underline
syntax, so `.md` keeps bold/italic and drops underline (documented, expected).

## 4. Data model changes

Migration `0005_enrich.sql`:

```sql
-- Emphasis enrichment add-on (+0.2 credits/page). Orthogonal to mode.
ALTER TABLE jobs ADD COLUMN enrich INTEGER NOT NULL DEFAULT 0;
-- Per-page surcharge, snapshotted at count/start so the hold and any later
-- refund always agree even if the config rate changes between them. NULL until
-- counted; 0 when the add-on is off.
ALTER TABLE jobs ADD COLUMN enrich_rate_mcr INTEGER;

-- The surcharge refund on partial/failed enrichment is a positive allocation
-- row with created_by='system'. This partial unique index makes "at most one
-- system refund per job" a database guarantee, so a future code path that also
-- inserts a system allocation for a job fails loudly instead of silently
-- corrupting this refund's idempotency.
CREATE UNIQUE INDEX ux_ledger_system_refund ON credit_ledger(job_id)
  WHERE kind = 'allocation' AND created_by = 'system';

-- Surcharge rate and the OpenRouter model id (admin-editable without a redeploy).
-- enrich_model empty by default → add-on disabled end to end (§10).
INSERT INTO config (key, value) VALUES ('rate_enrich_mcr', '200');
INSERT INTO config (key, value) VALUES ('enrich_model', '');
```

The dead `express` column is untouched. `Job` gains `enrich: boolean` and
`enrichRateMcr: number | null`; the row mapper, `COLS`, and `createJob` are extended
(`enrich` defaults to `false` in `createJob` opts so existing call sites are unchanged).

## 5. Pricing, hold, and refund (money path)

**Rate.** One helper is used by both count and start:

```
totalRateMcr(db, mode, enrich) = rateFor(mode) + (enrich ? rate_enrich_mcr : 0)
```

`rateFor` (base mode rate) is unchanged. `CountResult` keeps its exact shape
`{ ok, pageCount, rateMcr, creditsMcr }` — `rateMcr` stays the **base** rate, and the
surcharge shows up only in `creditsMcr`. So the existing `count.test.ts` `toEqual`
assertions stay green for `enrich=0`, and the bulk gate (which uses `creditsMcr`) sees the
surcharge automatically.

**Count (no charge).** `countJob` reads `job.enrich`, computes
`enrichRateMcr = enrich ? rate_enrich_mcr : 0`, stores **both** `rate_mcr` (base) and
`enrich_rate_mcr` (snapshot) on the job via `recordCount`, and returns
`creditsMcr = (rate_mcr + enrich_rate_mcr) × pages`.

**Start (hold).** The hold is `(rate_mcr + enrich_rate_mcr) × pages`. `enrich_rate_mcr` is
resolved as `job.enrichRateMcr ?? (job.enrich ? live rate_enrich_mcr : 0)` and written in
the same `transition` that records `rate_mcr` — so the **single-file path that skips a
prior count still snapshots the surcharge** (fixes the count-skipping gap). `enrich_rate_mcr`
is added to the `TRANSITION_COLS` whitelist.

**Finalize (capture + per-page refund).** Capture is unchanged. Then:

```
enriched  = clamp(Number(out.enrich?.pages_enriched ?? 0), 0, page_count)
refundMcr = enrich_rate_mcr × (page_count − enriched)          // snapshot, never live config
```

`enrich_rate_mcr` NULL or 0 → `refundMcr = 0`. `Number(… ?? 0)` + clamp makes NaN
impossible even if the container omits or malforms the summary (a missing summary with the
add-on on refunds the full surcharge — safe toward the user).

The refund is one positive `allocation` row, `created_by='system'`, note
`emphasis surcharge refund: <M-K>/<M> pages`, inserted with a single guarded statement:

```sql
INSERT INTO credit_ledger (user_id, kind, amount_mcr, job_id, note, created_by)
SELECT ?userId, 'allocation', ?refundMcr, ?jobId, ?note, 'system'
WHERE ?refundMcr > 0
  AND EXISTS     (SELECT 1 FROM credit_ledger WHERE ref_id = ?holdId AND kind = 'capture')
  AND NOT EXISTS (SELECT 1 FROM credit_ledger
                  WHERE job_id = ?jobId AND kind = 'allocation' AND created_by = 'system');
```

- **Only refunds a captured hold.** If the hold was *released* (job failed / cancelled /
  stale-swept), the full hold **including** the surcharge was already returned, and
  `EXISTS(capture)` is false → no double refund. This decouples the refund from
  `captureHold`'s racy boolean return and ties it to the durable capture row.
- **Fires exactly once.** The `NOT EXISTS` guard plus the `ux_ledger_system_refund` unique
  index give idempotency across retries and true concurrency; a unique violation is caught
  and read as "already refunded" (mirrors `captureHold`). A crash *between* capture and this
  insert is safe: on retry the capture row exists and no refund row does yet, so it fires
  once (no lost refund).

Storing `rate_mcr` as base-only does not affect the cron orphan-hold sweep (it keys on
`credit_ledger.job_id`, unchanged) or admin views (system refunds are distinguishable by
`created_by='system'` + note; admin allocations never carry `job_id`).

**Refund kind rationale.** The ledger `kind` CHECK allows only
`allocation/hold/capture/release`, and rebuilding the FK-referenced live money table to add
a `refund` kind is not worth the risk. A positive `allocation` with `created_by='system'`
satisfies the sign/magnitude CHECK, keeps balance = SUM(amount_mcr), and is now
DB-guaranteed unique per job by the index above.

## 6. Container enrichment pass

Runs in `/process` after `convert_book_reflow` builds `doc.json`, before the response is
assembled. Gated on `?enrich=1` **and** a non-empty model **and** a present OpenRouter key;
otherwise a no-op reporting `pages_enriched = 0`. If it throws unexpectedly it is caught and
the book ships plain — fail-open on the add-on, never on the document.

On hand in `/process`: `verbatim[i]` (page i's raw OCR, incl. per-block `content`), the
built `Doc`, the PDF path (re-rasterize on demand), `cfg`.

**Step A — per page, one OpenRouter call (concurrent, reusing `_OCR_CONCURRENCY`).**
Re-rasterize page i (`rasterize_page` + `_trim`, one image at a time to bound memory),
PNG-encode. Take page i's text blocks from `verbatim[i]` (each block's `content`, in OCR
order) as a JSON array. Send image + array + the configured instruction; expect a
**same-length** JSON array whose element *k* is block *k*'s text returned **verbatim** with
only `<b>/<i>/<u>` (or `<strong>/<em>`) inline tags added. Bounded retry on transient HTTP
errors; final failure or a wrong-length response → the page is **not enriched** (refunded),
no emphasis applied.

**Step B — per-block integrity gate + style parse (byte-exact, NO normalization).**
For each returned element, tokenize into literal text and recognized emphasis tags only
(`b/i/u/strong/em`, case-insensitive), tracking an open-count per style; a character's style
is `{bold: b>0, italic: i>0, underline: u>0}`. **Reject the block** (rendered plain, its
emphasis dropped) if any of: an unrecognized `<…>` token, any `&…;` entity, a close with no
matching open, a tag still open at end, or — after removing recognized tags — the literal
text is not **byte-equal** to the input block text (no whitespace normalization, so a
reflowed space or an entity fails the gate). Output: emphasized spans as
`(start, end, style)` in the block text's own coordinates.

**Step C — map spans onto Doc runs by monotonic alignment.**
Build the Doc's paragraph-text stream: concatenate every `Paragraph` run's text in node
order, recording each character's `(node_index, run_index, offset)`. Headings/tables/
figures are not in the stream (v1 scope). Maintain a monotonic cursor; for each page in
order, align that page's block texts against the stream slice `[cursor, cursor+window]` with
`difflib.SequenceMatcher` (tolerant of the engine's de-hyphenation, header/footer trimming,
and minor reordering), then advance the cursor past the matched region. Each emphasized
block-coordinate span maps through the alignment to a Doc character range. **Spans that do
not map** (trimmed running heads, de-hyphenation seams, low-confidence regions) are dropped
— recall loss only, never corruption. This is why cross-page paragraph merging cannot break
anything: we never assume a paragraph is a clean page unit; we align page-native text into
whatever Doc offsets actually match.

**Step D — split runs, OR-in existing style.**
For each mapped Doc range, split the affected `Paragraph`'s run(s) at the range boundaries
and set each resulting sub-run's `bold/italic/underline = existing OR detected`. Sub-run
text is **sliced from the Doc's original run text**, so full text and whitespace are
preserved by construction and any engine-detected `bold` (from type-size) survives.

**Step E — summary & billing.** A page is **enriched** (surcharge earned) iff its
OpenRouter call succeeded and returned a structurally valid (correct-length) response — the
detection ran and we could use it. Individual block gate-failures skip that block but do not
un-bill the page. A page is **not enriched** (refunded) iff the call errored after retries
or the response was unusable. Return:

```json
"enrich": { "requested": true, "pages_total": N, "pages_enriched": K }
```

Absent `enrich` / unconfigured → `{ "requested": false, "pages_total": N,
"pages_enriched": 0 }`; with `enrich_rate_mcr = 0` this yields neither charge nor refund.
Billing keys on the **per-page gate over page-native block text** (a clean unit whose image
and text always correspond), so the Doc's cross-page merging never mis-bills.

**OpenRouter client.** A small `httpx` helper POSTing chat-completions with a vision message
(image data URL + text). Model id comes from the request (the Worker passes the config
value); the key comes from the `x-openrouter-key` header (never logged). Timeout + bounded
retry mirror the OCR path. The instruction is a versioned constant in the container.

## 7. Engine change (underline) — minimal, additive

The only change to `src/pdf2fxl`:

- `docmodel.py`: add `underline: bool = False` to `Run`. `asdict`/`from_json` carry it;
  old `doc.json` without the field defaults to `False` (backward compatible; existing
  `test_docmodel` unaffected).
- `render_epub_reflow.py` `_runs_html`: after bold/italic, `if r.underline: t = f"<u>{t}</u>"`.
- `render_docx.py`: `run.underline = r.underline`.
- `render_md.py`: unchanged (Markdown cannot express underline).

Bold/italic need **no** engine change — already rendered, and every renderer already loops
multiple runs per paragraph, so splitting one run into several is fully supported today.

## 8. Worker plumbing

- **`routes/jobs.ts` `POST /`**: read `enrich` from query (`?enrich=1`); pass to `createJob`.
  Reject `enrich=1` with a clear **409** when the add-on is unconfigured, so the box never
  silently no-ops.
- **`jobs.ts`**: `Job` gains `enrich`, `enrichRateMcr`; row mapper, `COLS`, `createJob`
  (optional `enrich`), and `TRANSITION_COLS` (`enrich_rate_mcr`) updated.
- **`start.ts`**: `rateFor` → `totalRateMcr`; `countJob` + `recordCount` snapshot
  `enrich_rate_mcr`; `startJob` resolves and snapshots it (incl. the count-skipping branch)
  and holds `(base+surcharge)×pages`.
- **`finalize.ts`**: `realProcess` adds `enrich=1` + the model id to the `/process` query and
  forwards `x-openrouter-key`; `FinalizeRow`/`toJob` read the new columns; after capture,
  post the guarded per-page refund from `out.enrich`. `ProcessFn`'s return type gains an
  optional `enrich` summary; the finalize test fixture is updated.
- **`index.ts` `/api/config`** (unauthenticated, already fetched at load): becomes async and
  returns `enrich: { available, rateCredits }` where
  `available = Boolean(env.OPENROUTER_API_KEY) && (config.enrich_model is non-empty)` and
  `rateCredits = rate_enrich_mcr / 1000`. Single source of truth for both visibility and
  price.

## 9. Frontend plumbing (`index.html`, `app.js`, `ui.css`)

- Add the checkbox to the upload form, hidden unless `appConfig.enrich.available`; label
  shows the price from `appConfig.enrich.rateCredits`.
- `createAndUpload` gains an `enrich` argument; both the single (`uploadOne`) and bulk paths
  read the checkbox and append `&enrich=1` when checked.
- If `POST /` returns 409 for `enrich=1` (admin emptied the model between page load and
  submit), surface the returned error message rather than a generic upload failure.
- Minor styling to match the `.mode` controls.

## 10. Configuration & secrets (inputs required from Adnan)

- **`OPENROUTER_API_KEY`** — Worker secret (`wrangler secret put`), forwarded to the
  container as `x-openrouter-key`. Never logged, never returned.
- **`enrich_model`** — OpenRouter model id in the D1 `config` table (changeable without a
  redeploy). Empty by default → add-on disabled.
- **Instruction/prompt** — exact wording, versioned as a reviewed constant in the container.
  Placeholder until provided.

`enrich.available` is true iff the secret is present **and** `enrich_model` is non-empty.
Until both are set the checkbox is hidden and `enrich=1` is rejected — the feature ships
dark and lights up when Adnan sets the two values and supplies the prompt.

## 11. Failure modes & safety invariants

- **Model alters/drops/reflows text, or emits an entity** → byte-exact gate rejects that
  block → shipped plain. **Text is never corrupted** because rendered text is always sliced
  from the Doc's original, never from model output.
- **Model erases pre-existing bold** → impossible: split runs OR-in the source run's
  existing `bold/italic/underline`; enrichment can only add.
- **Nested / overlapping / unbalanced tags** → per-style open-counters flatten proper
  nesting; unbalanced/unclosed → block rejected.
- **OpenRouter down / key missing / model empty** → pass no-ops → `pages_enriched = 0` →
  full surcharge refunded → normal OCR at base price.
- **Cross-page merged / de-hyphenated paragraphs** → alignment maps what it can, drops the
  rest → reduced recall, never corruption, never mis-billing (billing is per-page on
  page-native text).
- **Finalize retry / crash windows** → capture idempotent (settlement index); refund
  idempotent + capture-gated (§5). Released hold → no double refund.
- **Config rate change mid-flight** → hold and refund both use the job's snapshot
  `enrich_rate_mcr`.
- **Malformed / missing container summary** → NaN-safe clamp; add-on-on with no summary
  refunds full surcharge.

## 12. Testing plan

**Container (pytest, stubbed OpenRouter — no network/key):**
- Tag-split: a block returned with `<b>`/`<i>`/`<u>` yields the right styled sub-runs;
  proper nesting (`<b>x<i>y</i></b>`) flattens to per-char styles.
- Gate rejects: changed word, dropped word, reflowed whitespace, an HTML entity, an
  unrecognized tag, unbalanced/unclosed tags → block left plain, text unchanged.
- **Text integrity:** rendered run text always equals the Doc's original (property: for any
  model output, concatenated run text is invariant).
- **Existing bold preserved:** a paragraph whose source run is `bold=True`, split by italic
  emphasis, keeps `bold=True` on all sub-runs.
- No-op paths: `enrich` absent / empty model / missing key → `requested`/`pages_enriched`
  correct, `doc.json` byte-identical.
- Underline round-trips through EPUB (`<u>`) and DOCX (`run.underline`).

**Worker (vitest):**
- `countJob` folds surcharge into `creditsMcr`, snapshots `enrich_rate_mcr`; `enrich=0` base
  case unchanged (existing `toEqual` green).
- `startJob` holds `(base+surcharge)×pages`, incl. the count-skipping path snapshot;
  insufficient-credit gate accounts for it.
- `finalize` posts the correct per-page refund for full / partial / none-enriched; is
  idempotent across a second finalize (no double refund); does **not** refund when the hold
  was released instead of captured; NaN-safe on a missing summary.
- `POST /` rejects `enrich=1` when unconfigured; accepts + persists when configured.
- `/api/config` reports `enrich.available` from secret + config.

## 13. Rollout / deploy

1. Migration `0005_enrich.sql` applied to D1 (remote).
2. Container rebuilt (enrichment module + underline change) and deployed.
3. Worker deployed with new routes/pricing/refund.
4. Ships **dark**: `enrich_model` empty, no OpenRouter secret → checkbox hidden, behavior
   identical to today.
5. Adnan sets `OPENROUTER_API_KEY` + `enrich_model` and supplies the prompt → add-on lights
   up; a live end-to-end test on a small styled PDF confirms emphasis and the correct
   charge/refund.

## 14. Open questions / future

- Exact OpenRouter model + prompt wording (Adnan to provide; placeholders until then).
- Future recall: fall back from exact alignment to fuzzy phrase search; emphasis in
  headings/captions; a model-confidence threshold.
- Future UX: show "N pages enriched" in the job detail so the user sees what the surcharge
  bought.
