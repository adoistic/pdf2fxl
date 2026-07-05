# pdf2fxl — Reflow mode design

**Date:** 2026-07-05
**Author:** Adnan
**Status:** Approved design → implementation plan next

## 1. Goal

Add a **reflowable** output path to `pdf2fxl` for scanned *text* books (as opposed to
the existing fixed-layout picture-book path). Given a scanned PDF, run Mistral OCR to
recover text + block geometry, then produce a clean **reflowable EPUB3**, plus
**Markdown** and **DOCX**, with a correct, book-global heading hierarchy and
proportionally-sized figures/tables.

This is a new `--mode reflow` inside the existing tool. It reuses ingest + OCR + fonts
+ the per-page JSON contract. **The fixed-layout path is untouched.**

### Guiding principle

Mistral OCR is trusted for *what a block is* (its **heading-vs-not classification is
correct**) and for *where it is* (bounding boxes) and *what it says* (text). Mistral is
**not** trusted for **heading hierarchy level** — it only sees one page at a time, so its
H1/H2/H3 assignment is unreliable. Reflow mode therefore:

- **Accepts** Mistral's block typing (heading blocks stay headings; paragraphs stay
  paragraphs — we never re-examine a paragraph as a potential heading).
- **Computes** the heading *level* itself, book-globally, using precise mathematical
  signals (measured type size clustered across the whole book + section-numbering depth).

## 2. Non-goals

- No re-classification of paragraphs into headings. Mistral's heading/non-heading split
  is authoritative.
- No changes to the fixed-layout EPUB/PPTX renderers.
- No new OCR provider; Mistral OCR 4 only.
- Reflowable PDF output is **not** produced — PDF is inherently fixed-layout; the
  reflowable deliverable is the EPUB (Markdown/DOCX are the companion structured exports).

## 3. Reference corpus (difficulty spectrum)

Design is validated against three real scanned books, chosen to cover the range:

| Book | Hierarchy signal | Layout complications |
|------|------------------|----------------------|
| *Dysbiosis of the Evolved Intestinal Microbiome* | Font size only; run-in bold lead-ins at body size | Clean single-column |
| *Antimicrobial Alternatives Against Resilient Oral Biofilms* | **Section numbering** (1 / 1.1 / 1.2.1) + font size | Real multi-column table; color figure + captions |
| *बळिचे राज्य येणार आहे* (Sharad Joshi, Marathi) | Font size only (no numbering) | **Two-up spreads**, running headers/footers, chapter openers, **drop caps**, Devanagari |

## 4. Architecture

New package `src/pdf2fxl/reflow/`. Data flows:

```
PDF ──ingest──▶ page images ──OCR (Mistral)──▶ Blocks (bbox, type, text)
                                                    │
                         reflow/typesize  ◀─────────┤  (+ page images)
                         reflow/layout     ◀────────┤
                         reflow/hierarchy  ◀────────┘
                                    │
                                    ▼
                         reflow/docmodel  (ordered Doc nodes, JSON-serializable)
                                    │
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
        render_md.py         render_docx.py       render_epub_reflow.py
        (GFM Markdown)       (python-docx)        (reflowable EPUB3)
```

### 4.1 Modules

- **`reflow/typesize.py`** — measure each text/heading block's true type size from the
  rendered page image; also emit line count and simple weight/centering features.
- **`reflow/layout.py`** — spread/column detection, header/footer stripping, reading-order
  sort, drop-cap merge, cross-break paragraph re-join.
- **`reflow/hierarchy.py`** — book-global body-size estimation, heading-tier clustering,
  numbering parser, level assignment for heading blocks. Pure functions, no I/O.
- **`reflow/crop.py`** — crop figures/tables/formulas from the source scan; compute
  proportional widths.
- **`reflow/docmodel.py`** — Doc node dataclasses + JSON (the debug contract).
- **`reflow/assemble.py`** — orchestrates pages → Doc.
- **`reflow/render_md.py`**, **`reflow/render_docx.py`**, **`reflow/render_epub_reflow.py`**
  — three renderers off the Doc model.

### 4.2 Wiring

- `cli.py`: add `--mode fxl|reflow` (default `fxl`, preserving current behaviour) and the
  reflow flags (§7). Reflow-only flags are ignored in `fxl` mode.
- `pipeline.py`: branch on mode. Reflow reuses `ingest` + `run_ocr`; skips `textmask`,
  `inpaint`, `fittext`, `render_epub`, `render_pptx`.
- `ocr.py` / parser: reflow needs a block-typing policy that **keeps** heading, text,
  list, caption, table, image blocks and preserves Mistral's line breaks (a
  newline-preserving variant of `_clean_text`, since line count feeds size estimation).
  Header/footer/page-number handling moves into `reflow/layout.py` (position + repetition)
  rather than a blanket drop, so running heads are stripped but real content is kept.

## 5. The math (heart of the feature)

### 5.1 Per-block type size — measured from pixels

For each block, crop its bbox from the page image (already rendered at known DPI) and
compute the **horizontal ink-row projection** (sum of dark pixels per row). Text lines
appear as periodic ink bands. Define:

- `pitch` = median distance between consecutive band centers (line-to-line spacing).
- `size_px` = the block's type-size proxy. For multi-line blocks `size_px ∝ pitch`; for
  single-line blocks (most headings) use the band thickness (cap/x-height) directly.
- `n_lines = round(box_height / pitch)` — free, and used for paragraph/heading disambig
  of measurement only (not re-classification).

Rationale: this is grounded in actual ink, independent of how Mistral segments text, so a
one-word heading in a wide box measures its **real** size — exactly where the fixed-layout
`fittext.py` fit-to-box approach would over-estimate. `fittext.py` is untouched; it is the
wrong tool for *measuring* size and is not used here.

Robustness: fall back to `box_height / n_lines` (from Mistral's preserved line breaks) when
the crop is too noisy to find clean bands (e.g. text over a figure).

### 5.2 Body size — from global text mass

Bin every **non-heading** text block's `size_px` (weighted by character count) across the
whole book. The peak bin is `body_size`. Body text dominates a real book's character mass,
so this is stable and needs no per-book tuning.

### 5.3 Heading levels — clustering + numbering

Only blocks **Mistral typed as headings** get levelled.

1. **Numbering parse (authoritative when present).** Regex the leading token of the heading
   text for section numbering and derive `num_depth`:
   - Latin dotted: `^\d+(\.\d+)*\.?\s` → depth = count of numeric groups (`1.`→1, `1.2.`→2,
     `1.2.1.`→3).
   - Also recognise `Chapter N`, Roman numerals, and Devanagari numerals/number-words.
   - When a heading has numbering, `num_depth` maps directly to level.
2. **Size tiers (used when no numbering, and to rank within a depth).** Compute
   `r = log(size_px / body_size)` for heading blocks; cluster `r` by natural breaks into
   tiers; rank tiers largest→smallest = H1..Hn.
3. **Reconcile** into one book-wide, monotonic map: numbering depth is authoritative where
   it exists and is consistent; size tiers fill in unnumbered books and break ties. The
   output level for a given (num_depth, size_tier) pairing is consistent across the whole
   book.
4. **Run-in lead-ins** (bold phrase at body size that Mistral kept *inside* a paragraph,
   e.g. "Opportunity:", "Pellicle formation:") are **not** headings — they render as inline
   `<strong>`. A flag can promote them to the lowest heading level, off by default. (We do
   not manufacture these ourselves; we only honour what Mistral already segmented.)

### 5.4 Image/figure/table/formula sizing — proportional

- Crop each figure/table/formula block's bbox (+ small padding) from the source scan.
- **Reflow width** = `bbox_width / text_column_width` → CSS `width: NN%` (clamped ≤100%),
  aspect ratio preserved. Half-column figure stays half-column; full-page plate stays
  full-width.
- **Classification** from `area_fraction = bbox_area / page_area` + aspect + position:
  `plate` (large; own block, optional page break) / `figure` (block-level) / `inline`
  (tiny marks). Drives placement, not correctness.

## 6. Layout normalization

- **Spread/column detection** (`--layout single|two-up|auto`, default `auto`): cluster block
  x-centers; two well-separated full-height groups ⇒ two columns / two-up spread. Reading
  order: left group top→bottom, then right group. (Marathi book = two-up.)
- **Header/footer stripping:** blocks in top/bottom margin bands that are page numbers or
  repeat across many pages (running heads) are dropped; detected by y-position +
  cross-page text repetition, incl. Devanagari numerals.
- **Drop-cap merge:** a 1–2 glyph oversized block overlapping the following paragraph's
  start becomes that paragraph's first letter (rendered via CSS `::first-letter` or an
  inline span), never a heading (Marathi "शा").
- **Paragraph re-join across page/column breaks:** if a body block does not end
  sentence-final and the next body block starts non-capital (or the prior ends in a
  hyphen), join into one paragraph (de-hyphenating).

## 7. Configurability (CLI surface)

Reflow is deliberately un-opinionated about fidelity; the user chooses per run.

- `--mode fxl|reflow` (default `fxl`).
- `--formats epub,md,docx` (comma list; default all three in reflow mode).
- `--tables html|image` (default `html`) — real reflowable `<table>` from Mistral's
  structure, or a crop from the scan.
- `--figures image|drop` (default `image`) — crop from scan, or omit.
- `--formulas mathml|image|text` (default `image`) — LaTeX→MathML, a scan crop, or plain
  text. Crop is the safe default for equations.
- `--layout single|two-up|auto` (default `auto`).
- `--promote-runins` (flag, default off) — promote bold run-in lead-ins to lowest heading.
- Existing `--font`, `--title`, `--language`, `--dpi` continue to apply.

## 8. Document model

`reflow/docmodel.py` defines an ordered list of nodes, JSON-serializable (mirrors the
existing per-page JSON "contract" philosophy so the intermediate is inspectable):

- `Heading(level: int, text: str)`
- `Paragraph(runs: [Run])` where `Run(text, bold, italic, is_dropcap)`
- `Figure(src: str, caption: str|None, width_frac: float, kind: plate|figure|inline)`
- `Table(html: str | None, image_src: str | None, caption: str|None)`
- `Formula(mathml|text|image, caption: str|None)`
- `ChapterBreak` (inserted before each H1; drives EPUB spine splitting)

Renderers:

- **Markdown:** `#`×level headings, paragraphs, `![alt](src)`, GFM tables.
- **DOCX:** python-docx Heading styles, images (scaled by `width_frac`), native tables.
- **EPUB3 reflowable:** one XHTML per H1 (ChapterBreak), semantic `<h1..h6>`/`<p>`/
  `<figure><img><figcaption>`/`<table>`; `nav.xhtml` TOC built from the heading tree;
  reuses the existing `@font-face` embedding + `font_family()` so `--font` works for
  Devanagari.

## 9. Testing & verification

**Deterministic unit tests (no API):**
- `hierarchy.py`: numbering depth parsing (Latin/Roman/Devanagari), tier clustering,
  body-mass mode selection, numbering↔size reconciliation, run-in exclusion.
- `typesize.py`: synthetic images with known line pitch → correct `size_px`/`n_lines`.
- `layout.py`: synthetic fixtures for two-up split, header/footer strip, drop-cap merge,
  cross-break paragraph join.
- Golden Doc-model JSON for a handful of real pages via a fake-OCR fixture.

**Visual gate (project hard rule — never trust geometry for visual output):**
- Render each of the three books' reflow EPUBs, screenshot in headless Chrome, verify the
  `<nav>` heading outline matches the book's real structure, spot-read body text, confirm
  figures/tables placed sanely. Run `epubcheck`. No "done" without eyeballing.

## 10. Risks & mitigations

- **Noisy scans break ink-band detection** → fall back to `box_height / n_lines` from
  Mistral line breaks (§5.1).
- **Mistral mis-types a heading as text (or vice-versa)** → accepted per the guiding
  principle; we do not second-guess. If it proves common on these books, revisit as a
  separate change, not by re-adding paragraph re-classification.
- **PIL cannot complex-shape Indic** (known caveat) → size measurement is image-based here,
  so it is unaffected; only DOCX/Markdown width estimates that rely on text metrics could
  drift, and figures use measured pixels.
- **Two-up detection false-positive on a wide single-column page** → require two
  *full-height* x-clusters with a clear central gutter before splitting; `--layout single`
  overrides.
