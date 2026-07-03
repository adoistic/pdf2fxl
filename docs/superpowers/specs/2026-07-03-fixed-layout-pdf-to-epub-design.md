# Fixed-Layout PDF → EPUB + PPTX Pipeline — Design

**Date:** 2026-07-03
**Author:** Adnan (Thothica)
**Status:** Approved for planning

## Problem

We have print-ready children's picture books delivered as **image-only PDFs** (flattened
InDesign exports with crop marks + slug footers; no selectable text). We want to convert
each book into:

1. A **fixed-layout EPUB3**, and
2. A **PPTX** deck,

where the illustration and the text are **genuinely separate layers**: the printed words are
erased from the artwork and replaced with **real, editable, translatable text** positioned
where the original text sat. The process must be **fully automated** — no human-in-the-loop
review or correction step.

### Sample inputs analyzed

| | `Little_Elephant.pdf` | `Grandma.pdf` |
|---|---|---|
| Title | *Little Elephant Throws A Party* | *A Lesson From Grandma* |
| Pages | 20 | 16 |
| Orientation | Landscape, ~4:3 | Landscape, ~4:3 |
| Art | Gouache/collage | Watercolor |
| Text | Dark serif on light bands (mostly bottom) — cleanly separable | Dark serif column (right/bottom), sometimes over busy washes |

Both carry **crop/registration marks and a slug footer** on every page that must be trimmed.
Text is crisp printed type (not a phone scan), so OCR accuracy is high. Layout is simple:
1–3 short paragraphs per page, single-column reading order.

## Goals

- **Deliverable (v1): a command-line application (CLI)** — a single command
  (e.g. `pdf2fxl <book.pdf> -o out/`) runs the whole pipeline and writes the EPUB + PPTX.
  No GUI, web UI, or long-running service.
- Fully automated PDF → EPUB + PPTX, no human review.
- Erase printed text from artwork (clean art layer) via **fidelity-preserving** inpainting.
- Real editable text placed at the original position, size, color, and alignment.
- One reusable pipeline runnable across a catalog of books.
- Architecture extensible to Indic scripts (Tamil, Telugu, Devanagari, Bengali, …) later.

## Non-goals (v1)

- **Non-Latin scripts.** v1 targets **Roman/Latin only** (the two English books). The OCR
  engine (Mistral OCR 4) supports Indic natively, but rendering fonts/QA for those is deferred.
- **Exact typeface matching.** We reproduce position/size/color/alignment; the typeface is a
  chosen per-language font (Noto), not a reverse-engineered match.
- **Human review / correction UI.** Explicitly out — rare OCR/inpaint errors ship as-is.
- **Translation.** The pipeline makes text editable; translating it is downstream.
- **Complex layouts** (nested tables, >2 columns). Simple single-column sort only.
- **GUI / web app / hosted service.** v1 is a local command-line app only.

## Architecture — 5-stage pipeline

```
PDF ─▶ [0] Ingest ─▶ [1] OCR+Layout ─▶ page.json ─▶ [2] Inpaint ─▶ [3] Style ─▶ [4] Render ─┬─▶ EPUB
       (trim art)     (Mistral OCR 4)  (the           (LaMa,        (fonts,      │           └─▶ PPTX
                                        contract)      clean art)    sizes)   both read the SAME json
```

The **intermediate JSON per page is the contract** between "read" and "render." OCR writes it;
both renderers consume it. Adding a new language edition = re-run OCR, same renderers. Even
without a human gate, this keeps stages decoupled and independently testable.

### Intermediate representation

```jsonc
// out/<book>/pages/page-07.json
{
  "index": 7,
  "page_size_px": [2048, 1536],       // trimmed page pixel dimensions
  "background": "page-07-clean.png",   // artwork with text erased (Stage 2)
  "original": "page-07.png",           // trimmed artwork WITH text (debug/QA)
  "blocks": [
    {
      "type": "text",                 // Mistral block type (text|title|list|caption|…)
      "bbox": [x, y, w, h],            // pixels on the trimmed page
      "text": "Anita was a delightful painter…",  // logical paragraph, no hard line breaks
      "script": "Latn",
      "font_px": 34,                   // estimated from glyph height (Stage 1.5)
      "color": "#1a1a1a",             // sampled from masked text pixels (Stage 1.5)
      "align": "left",                // left | center | right | justify
      "reading_order": 0,
      "confidence": 0.98
    }
  ]
}
```

Text is stored as a **logical paragraph without hard line breaks** so the renderer wraps it
inside the block box. This keeps it correct when translated text has a different length.

### Stage 0 — Ingest & trim

- **PyMuPDF (fitz)** rasterizes each PDF page to PNG at a fixed zoom (~300 DPI target).
- **Trim crop marks + slug footer:** prefer the PDF `TrimBox` when present and smaller than
  the `MediaBox`; otherwise auto-detect content bounds (largest non-white region) and strip
  the thin slug band at the bottom edge. (Physically removes the marks/slug from the artwork;
  the OCR-side footer drop in Stage 1 is a separate safety net for the text layer.)
- Output: `page-XX.png` (trimmed artwork with text) + recorded `page_size_px`.

### Stage 1 — OCR + layout (Mistral OCR 4)

- `mistral-ocr-4-0` with `include_blocks=True` on each trimmed page image → per-page `blocks`
  array: each block has a **type** (text, title, list, caption, table, image, equation,
  header, footer, page_number, …), a **bounding box** (`top_left_x/y`, `bottom_right_x/y`),
  and its **content** — already in **reading order**.
- **170 languages** including all major Indic scripts (Tamil, Telugu, Hindi, Bengali, Kannada,
  Malayalam, Gujarati). This is why we switched from Google Vision: native Indic accuracy plus
  typed, boxed, reading-ordered blocks in one call.
- **Filtering:** keep text-bearing blocks (`text`, `title`, `list`, `caption`); **drop**
  `header`/`footer`/`page_number` — which discards the slug line so it never becomes editable
  text (`extract_footer=True` reinforces this).
- Coordinates normalized to fractions of `page_size_px` via the returned `dimensions`.
- Writes the block list (type, bbox, content, reading_order, confidence) into `page-XX.json`.

> **Granularity note:** Mistral returns **paragraph/block-level** boxes, not word-level. We do
> *not* depend on word boxes for the inpaint mask or style — those come from the local pixel
> pass (Stage 1.5), so block-level boxes are sufficient. Exact SDK field names to be confirmed
> against the live API on the first run (one test call).

### Stage 1.5 — Local text-pixel mask + style estimation

Block boxes are coarse, so we derive precise pixel-level data locally, independent of the OCR
engine's box granularity:

- Within each text block's bbox on the *original* (pre-inpaint) image, **threshold the dark
  text pixels** (text is dark on lighter art) → a tight binary **text mask**.
- From that mask: `font_px` ← glyph-row height (connected-component / row-profile heights);
  `color` ← median of the masked dark pixels; `align` ← line start/end x-positions relative to
  the block bbox.
- The union of all block masks (dilated a few px) becomes the **inpainting mask** for Stage 2 —
  tight to the actual glyphs, so we repaint as little artwork as possible.

### Stage 2 — Inpaint (clean art layer)

- The **Stage 1.5 text mask is the inpaint mask** (dilated a few px to cover anti-aliasing and
  glyph overhang) — tight to the glyphs, not the whole paragraph rectangle.
- **IOPaint + LaMa**, run locally (CPU/MPS). Input: original page + mask → output: clean
  background with text pixels erased and everything else pixel-identical.
- Chosen over generative (OpenRouter) editors because LaMa **cannot drift/hallucinate the
  artwork** — it only touches masked pixels. Essential when nothing is watching. Busy washes
  (e.g. Grandma's curtains) may leave a faint smudge — accepted under full automation.
- Output: `page-XX-clean.png`, referenced as `background` in the JSON.

### Stage 3 — Style / fonts

- **Font map per script:** `{ "Latn": "Noto Serif", … }`. v1 = Latin → **Noto Serif** (books
  use a serif). One open Noto family extends to every Indic script later with new map entries.
- Font files embedded in the EPUB; PPTX sets the font name (true PPTX font embedding is a
  future nicety — see Risks).
- Size/color/alignment come from Stage 1.5.

### Stage 4 — Render (same JSON → two files)

**Fixed-layout EPUB3**
- Standard FXL package: `mimetype`, `META-INF/container.xml`, `OEBPS/` with `content.opf`,
  `nav.xhtml`, `page-XX.xhtml`, `images/`, `fonts/`, `styles/`.
- Each `page-XX.xhtml`: `<meta name="viewport" content="width=Wpx, height=Hpx">` equal to
  `page_size_px`; a full-page `<img>` clean background; each block as an absolutely-positioned
  `<div>` (px coords matching the page canvas; reader scales the whole viewport). Text wraps
  within the block width. Embedded Noto fonts via `@font-face`.
- OPF metadata: `rendition:layout = pre-paginated`, spread properties, spine order, cover =
  page 1 image.
- Package: `mimetype` stored first (uncompressed), rest deflated → `.epub`. Validate with
  epubcheck; smoke-test in Apple Books / Thorium.

**PPTX** (`python-pptx`)
- Slide size set to the book's aspect (landscape ~4:3) in EMU.
- Background: clean page image as a full-slide picture.
- Each block → an editable **text box** at `bbox` fraction × slide dimension (→ EMU), with
  text, font name/size/color, alignment, word-wrap on, autosize off.

Both renderers map `bbox` (px on the trimmed page) → fractional coords → target units, so the
same JSON drives both.

## Tech stack

All local Python on macOS (Apple Silicon):

- **PyMuPDF** — rasterize + trim.
- **mistralai** (Mistral OCR 4, `mistral-ocr-4-0`) — OCR + typed blocks + bounding boxes + reading order.
- **OpenCV / scikit-image + NumPy** — Stage 1.5 local text-pixel masking & glyph measurement.
- **IOPaint (LaMa)** — mask-based inpainting (CPU/MPS).
- **Pillow** — image I/O, style sampling.
- **python-pptx** — PPTX output.
- **lxml** (hand-rolled FXL XML) — EPUB output.
- **click/argparse** — CLI. Optional **epubcheck** (Java) for validation.

Cost: Mistral OCR 4 at $4 / 1,000 pages (batch $2) → both books (~36 pages) ≈ 15 cents.

## Configuration

Per-book config with sensible defaults: input PDF, output dir, DPI/zoom, OCR model, block types
to keep/drop, font map, PPTX aspect, mask dilation px, trim strategy (auto | trimbox | fixed-margin).

## Risks & accepted trade-offs (under full automation)

- **Inpaint smudges** on busy artwork — no human to catch; accepted.
- **Heuristic style estimation** (font size/color/align) — occasional misses; accepted.
- **Block-box granularity** — Mistral gives paragraph-level boxes; mitigated by Stage 1.5 local
  masking. Confirm exact API/SDK field names on the first run.
- **Reading-order edge cases** — low risk (simple single-column books; Mistral returns reading order).
- **EPUB FXL reader compatibility** — mitigate by validating + smoke-testing in real readers.
- **PPTX font portability** — v1 sets font name; if Noto isn't installed on the opener's
  machine it substitutes. True embedded-font packaging is a stretch goal.
- **Mistral OCR setup** — requires a `MISTRAL_API_KEY`; documented in setup.

## Future extensions

- Indic fonts per script (Noto Serif/Sans Tamil, Telugu, Devanagari, Bengali, …), unlocked by
  Mistral's native Indic OCR + font-map entries.
- Optional generative-inpainting fallback for the hardest pages.
- Embedded fonts in PPTX for full portability.
- Translation stage consuming/producing the same JSON.

## References

- Mistral OCR 4 announcement — https://mistral.ai/news/ocr-4/
- Mistral OCR model card (`mistral-ocr-4-0`) — https://docs.mistral.ai/models/model-cards/ocr-4-0
- OCR processor / basic OCR — https://docs.mistral.ai/studio-api/document-processing/basic_ocr
- Document annotations — https://docs.mistral.ai/studio-api/document-processing/annotations
