---
name: thothica-translate
description: Translate text, documents, or whole books with literary or commercial register, full per-language grammar/localization rules, poetry-form awareness, and script-integrity guards. Use when the user wants to translate prose, poetry, scripture, scripts, or any document into another language or dialect, or asks to "translate", "localize", or "render in <language>". Handles short snippets inline and book-length works via sequential rolling-context translation; multiple independent documents via parallel Opus sub-sessions.
---

# Thothica Translate

A self-contained translation skill. The engine is Claude itself — no external translation API.

## Corpus (load on demand — do not read everything up front)

Use progressive disclosure. Most corpus files are read only when they are relevant to the job in front of you. Never bulk-load the corpus.

- `stances/literary.md`, `stances/commercial.md` — load the ONE matching stance file **after** you have chosen the stance (see "Stance & content-type detection"). Never load both.
- `content-types/taxonomy.md` — load to **detect the content type** from the sample and to map that type to its default stance via its `## Stance mapping` table.
- `content-types/cultural.md`, `content-types/specialty.md`, `content-types/scripts.md`, `content-types/temporal.md` — load a file **only if** the detected content matches that category (cultural / specialty / scripts / temporal). Skip otherwise.
- `poetry/forms.md` — load **only when the content is poetry** (verse, lyrics, ghazal, sonnet, etc.).
- `languages/grammar/<lang>-grammar.md` — load for the **target language, always**, if a grammar file exists for it (14 languages: assamese, bengali, gujarati, hindi, kannada, malayalam, marathi, nepali, odia, punjabi, sinhala, tamil, telugu, urdu). If no file exists for the target, proceed without it.
- `languages/localization/<lang>-localization.md` and `languages/localization/english/<dialect>.md` — load **only when the localization pass is enabled** (opt-in). For English, load the dialect file the user picked (american, british, indian, aave, australian, canadian, desi, general, hong-kong, irish, jamaican, new-zealand, philippine, singapore, south-african, trinidadian). Non-English languages also have localization files (e.g. french, german, spanish, czech, nepali, maithili, dzongkha, bahasa-indonesia, bahasa-malaysia, hungarian, and the South Asian languages) — `ls languages/localization/` to see what's available.
- `languages/self-help/<lang>.md` — load **only when** the content is self-help AND the target language has a file.
- `languages/memoir/<lang>-memoir.md` — load **only when** the content is memoir AND the target language has a file.
- `languages/script-rules/urdu.md` — load **only when the target language is Urdu**.
- `languages/colloquial-map.md` — load when the **target is a South Asian language** to apply its colloquial register. Apply by default under the **commercial** stance; under the **literary** stance preserve the fuller literary register and apply only if the user explicitly asks for a spoken/colloquial voice. Always honor the script instruction in the map.
- `guards/word-count-ratios.md` — load **only when the word-count benchmark is enabled** (opt-in).
- `guards/script-integrity.md` — load **always** (it is cheap and the script-integrity guard is always on).

## Input/output formats

- **Plain text / markdown** — read the source directly. Write the translation as a sibling file named `<name>.<targetlang>.md` (e.g. `chapter1.md` → `chapter1.hindi.md`).
- **.docx** — convert to markdown first using the `anthropic-skills:docx` skill, translate the markdown, then render back to `.docx` if the user wants the output in Word. Preserving the markdown structure (headings, lists, tables, emphasis) is what keeps formatting intact across the round trip.
- **CSV / JSON / PPTX** — out of scope for v1. Do not attempt these; tell the user they are not yet supported.

## Routing

On **every** invocation, decide which of three paths applies before doing anything else:

1. **Short pasted or described text** (a snippet, with no file) → **INLINE**: do one translation pass in this session and reply directly in chat. No brief, no sub-sessions.
2. **A single coherent work** (one file, one book, one story, one essay) → **SEQUENTIAL** — see "Single work".
3. **Multiple independent documents** (several unrelated files, or a folder of them) → **PARALLEL** — see "Multiple documents".

If you are unsure whether several files form **one work** or **many independent works**, ASK the user before proceeding. Do not guess.

### Single work

A single work is translated as a continuous, ordered pipeline:

1. **Recon** — read a representative sample. Detect the source language, the content type, and the stance. Chunk the work on its **real chapter / section structure** (chapter breaks, scene breaks, section headings) — never on a blind word count.
2. **Brief** — write `translation-brief.md` capturing the decisions that must stay consistent across the whole work: terminology glossary, character-name decisions (transliterate vs. translate vs. keep), tone/register, stance, target dialect, and recurring motifs.
3. **Translate chapter-by-chapter, IN ORDER.** Each chapter is handed the brief PLUS the **actual translated text of the previous chapter** (rolling context), so voice, terminology, and motifs carry forward. Write each section to disk as it completes.

A single work is **NEVER** split into parallel chunks. Translation quality **is** continuity — register, recurring terms, character voice, and callbacks only hold together when each chapter is translated with the previous translation in hand. Parallelizing a single work breaks that continuity and is forbidden.

### Multiple documents

For a set of independent documents, run a **pre-flight intake** before any translation:

1. **One interactive pass** — scan ALL the documents up front. Surface EVERY clarifying question (source dialect, proper nouns, mixed content types across the set, target dialect, register) in a **SINGLE batch**. The user answers once.
2. **Then dispatch** one autonomous sub-session **per document**. Each sub-session runs the **full rigor** of the single-work pipeline (same corpus, same guards, same stance logic) and **NEVER blocks to ask a question mid-run** — every decision it needs was settled in the pre-flight intake.

## Model policy

- Every dispatched cloud sub-session uses the **latest Opus tier**: set the Agent `model` to `opus`.
- **NEVER use Sonnet** unless the user explicitly requests Sonnet for that job.
- **Do not pin a version.** Request the Opus tier (`opus`) so it always tracks the current latest Opus.

## Stance & content-type detection

- **Detect the content type** from the sample using `content-types/taxonomy.md`. If the user states the type explicitly, that **overrides** detection.
- **Map content type → category → default stance** using the taxonomy's `## Stance mapping` table (category → literary | commercial). The user may **override** the stance ("do this in literary mode").
- Load **only** the matching `stances/<stance>.md` and any matching category guidance file (`content-types/cultural.md` | `specialty.md` | `scripts.md` | `temporal.md`). Use the taxonomy's `## Category guidance files` table to map the category to its one guidance file (or none). Do not load non-matching files.
- If the user asks to translate a text into a different historical period of the **same** language (e.g. Old English → Modern English, Classical Arabic → Modern Standard Arabic), treat it as **Temporal Translation** and load `content-types/temporal.md`.
- **Precedence:** the stance file governs REGISTER (literary vs commercial); a category guidance file contributes domain technique and cultural-adaptation guidance only — when they seem to conflict on tone, the stance wins.

## Quality features

- **Self-critique (opt-in)** — after translating, review the output against the brief/analysis for accuracy, fluency, completeness, and sense-for-sense vs. literal fidelity, then revise **ONCE**.
- **Localization + dialects (opt-in)** — a separate native-rewrite pass using `languages/localization/**`. The dialect is chosen by the user (for English: british / indian / aave / etc.).
- **Script-integrity guards (ALWAYS on)** — run the `guards/script-integrity.md` checks and fix any violations before finishing.
- **Word-count benchmark (opt-in; auto-off for poetry and scripts)** — apply `guards/word-count-ratios.md` and flag any output that falls out of the expected range.
