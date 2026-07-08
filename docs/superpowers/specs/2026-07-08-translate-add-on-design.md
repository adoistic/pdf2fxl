# Translate add-on design (2026-07-08)

Adnan's goal: translate any pasted text or any already-OCR'd book into any
language, inside Thothica OCR itself. The translation craft that previously
lived in an external skill is embedded in the app in full (the app has no
access to the skill at runtime). The hosted model behind it is configurable;
the launch model is a Gemini tier (chosen over Claude on cost). The option is
invisible unless the backend enables it for a specific user.

## Product rules (Adnan, verbatim intent)

- **Hidden by default.** Only users whose account has the flag set by the
  admin ever see the Translate option. Everyone else sees nothing.
- **Pricing: 500 credits per 350 words**, prorated per word
  (500/350 ≈ 1.4286 credits/word) and charged to two decimal places of a
  credit. 355 words → 507.14 credits.
- **Cap: 2,000 words per translation** while this is an experiment. Longer
  input is refused with a clear "sorry, that's not possible yet" message and
  no charge.
- **Any language**: English, every Indian language, and the major world
  languages are all offered.
- **Format preservation is critical.** Pasted markdown keeps its exact
  structure; a book translation swaps only the text inside the stored
  document structure (headings, paragraphs with bold/italic/underline runs,
  table HTML, captions), so every piece of text stays in its correct place
  and downstream fixed-position rendering keeps its geometry.

## Architecture

Same shape as the emphasis add-on: Worker owns auth, gating, pricing, credits
and storage; the Python container owns the compute; the model provider is
white-labeled behind one functional endpoint constant and a provider-neutral
key. The whole translation corpus (76 files: stances, content-type taxonomy +
category guidance, per-language grammar, colloquial register map, script
rules, localization, guards) is vendored at `src/pdf2fxl/translate/corpus/`
so the Docker image ships it via the existing `COPY src/`.

### Engine (`src/pdf2fxl/translate/`)

- `corpus.py` — loads corpus files on demand (progressive disclosure, mirrors
  the skill's routing): taxonomy stance + guidance tables parsed from the
  corpus markdown itself; grammar file per target language when one exists;
  colloquial-map row for South Asian targets (applied only under the
  commercial stance); Urdu script rules; both stance files.
- `engine.py` — two model calls per job. Call 1 (detect): a sample of the
  source + the taxonomy's auto-detection signals → content type, category,
  source language. Category → stance and guidance file resolved in code from
  the taxonomy tables. Call 2 (translate): system prompt assembled from
  stance + guidance + grammar + register + script rules + a strict
  format-preservation contract; input is either the raw markdown (paste) or
  a JSON array of the document's translatable segments (same-length-array
  contract, like enrichment).
- `guards.py` — the always-on script-integrity checks, deterministic: Urdu
  output must contain zero Devanagari; numerals must survive by count and
  value; markdown/HTML structure must match by element type and count. One
  retry with the violation report appended, then fail (hold released, no
  charge).
- Document translation: segments are Heading.text, Paragraph runs serialized
  to `<b>/<i>/<u>`-tagged text (spliced back through the same tag parser the
  enrichment gate uses, so styling and text integrity are enforced), Figure
  and Table captions, Table.html (tag sequence must match after translation),
  and the Doc title. Formula bodies and figure sources are never touched.
  `/render` already re-detects script and embeds the right webfonts, so a
  Hindi output EPUB gets Devanagari faces with no extra work.

### Container endpoints

- `POST /translate/quote` — {kind: text|doc, text|doc_json} → {word_count}.
  One canonical Python word count (markdown/HTML stripped, whitespace split);
  the Worker prices from this so billing and engine can never drift.
- `POST /translate` — source + target_language (+ model id, key via
  `x-translate-key` header) → translated markdown (+ translated doc_json for
  books) + detection metadata + guard report.

### Worker

- Migration 0007: `users.translate_enabled` (default 0), `translations`
  table (uuid id, user_id, kind text|book, job_id for books, target_language,
  status received|processing|ready|failed, word_count, block snapshot
  `block_words`/`block_mcr`, `charged_mcr`, hold_id, r2 keys, title, errors,
  timestamps), config rows `translate_model`, `translate_block_words` = 350,
  `translate_block_mcr` = 500000, `translate_max_words` = 2000.
- Pricing: `priceWordsMcr(words) = round(words * block_mcr / block_words / 10) * 10`
  — round-half-up to 10 mcr = two decimal places of a credit. Snapshotted on
  the translation row so a config change never moves a held amount.
- Key: `TRANSLATE_API_KEY` secret, falling back to `ENRICH_API_KEY` (same
  provider account today). Availability = key present AND model configured.
- Routes (all behind auth + per-user flag; 404-shaped 403 for the unflagged):
  `GET /api/me` gains `translate: {maxWords, blockWords, blockCredits}` only
  when the user is flagged and the add-on is configured; `POST
  /api/translate/quote`; `POST /api/translate` (validates, counts via
  container, refuses > cap with the sorry message, stores paste source to R2,
  places hold, enqueues); `GET /api/translate` (list), `GET
  /api/translate/:id`, `GET /api/translate/:id/result` (markdown for inline
  display), `GET /api/translate/:id/download?format=md|epub|docx` (book
  renders reuse the source job's figures).
- Queue: the existing ocr-jobs queue carries `{translationId}` messages next
  to `{jobId}`; `finalizeTranslation` mirrors `finalizeJob` (guarded status
  CAS, capture on success, release on any failure).
- Admin: `POST /api/admin/users/translate` {email, enabled} (pre-allocation
  upsert like credits), and the users list shows the flag.

### Frontend

- A `#translate` hash view like `#admin`: nav link + view render only when
  `/api/me` carries the translate object. Paste tab + "one of your books"
  tab (ready books only), grouped language list (English, Indian languages,
  wider South Asia, world), live word count + two-decimal price, the cap
  message at > 2,000 words, then a polled status card and the result with
  copy + download. Thothica voice: sentence case, no em or en dashes, no
  vendor names.

## Explicitly out of scope (v1)

- Books over 2,000 words (the cap applies to books too; most books will
  refuse for now, matching the experiment framing).
- Localization/dialect rewrite pass and word-count-ratio benchmark (opt-in
  features in the corpus; corpus is shipped, passes are not wired to UI).
- Fixed-layout cloud pipeline specifics: the cloud pipeline currently always
  produces the reflow doc model, and the per-segment splice already keeps
  text in place for any future layout JSON with the same node/run shape.
