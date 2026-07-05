# pdf2fxl

Convert image-only picture-book PDFs into a fixed-layout EPUB3 and a PPTX, replacing
baked-in printed text with real, editable text via Mistral OCR 4 + LaMa inpainting.

## Install
    python -m venv .venv && . .venv/bin/activate
    pip install -e '.[dev]'
    # LaMa inpainting backend (kept out of core deps — pins pillow<10):
    pip install torch && pip install --no-deps simple-lama-inpainting

## Use
    export MISTRAL_API_KEY=...        # or put it in a .env file in the CWD
    pdf2fxl /path/to/Book.pdf -o out/ --title "Book" --dpi 150
    # -> out/Book.epub, out/Book.pptx, out/pages/*.json (+ page images)

## Reflow mode (scanned text books -> reflowable EPUB / Markdown / DOCX)

For text books (not picture books), recover a reflowable document with a book-global
heading hierarchy computed from OCR geometry:

    pdf2fxl book.pdf -o out/ --title "Book" --mode reflow
    # -> out/Book.epub (reflowable), out/Book.md, out/Book.docx, out/Book.doc.json

Options:
    --formats epub,md,docx     # which outputs (default all three)
    --tables html|image        # real <table> vs a crop from the scan
    --figures image|drop       # crop figures, or omit them
    --formulas mathml|image|text
    --layout single|two-up|auto   # two-up = two book pages per scanned image
    --font <ttf>               # override the Latin base face (optional; rarely needed)

Fonts are assigned automatically. The bundled Noto Serif covers Latin, Greek, and
Cyrillic; every other script the book uses (Devanagari, Arabic, Tamil, CJK, and the
rest) is detected from the text, its Noto face fetched from Google Fonts, cached, and
embedded, with a `font-family` stack so `unicode-range` routes each script to its font.
A Latin-only book needs no network. See `reflow/scripts.py` and `reflow/fonts.py`.

Heading levels come from measured type size, clustered across the whole book and
reconciled with section numbering (1 / 1.1 / 1.2.1). Mistral's per-page hierarchy is
not trusted, but its heading-vs-not classification is. The math lives in
`src/pdf2fxl/reflow/` (typesize, hierarchy, layout); a `Doc` model feeds three renderers.

## Web console

A Thothica-branded web front end for reflow mode: drop a PDF, watch per-page OCR
progress, then read the recovered table of contents and download the editions.

    pip install -e '.[web]'
    pdf2fxl-web                 # or: python -m pdf2fxl.web  (serves http://127.0.0.1:8000)

It reads `MISTRAL_API_KEY` from the environment or a `.env` file. A finished conversion
has a shareable link (`/?job=<id>`) that resumes the result view. Single-process,
in-memory jobs; fine for desktop or internal use.

## Pipeline
0. Ingest & trim (PyMuPDF) · 1. OCR+layout (Mistral OCR 4) · 1.5 text mask + style ·
2. Inpaint (LaMa) · 3. Fonts · 4. Render EPUB + PPTX. A per-page JSON is the shared contract.

Reflow mode shares steps 0 and 1, then branches: measure type size, recover hierarchy,
assemble a `Doc`, and render EPUB/Markdown/DOCX (no inpainting).

## Tests
    pytest -q -m 'not slow'      # fast, deterministic (fakes for OCR + inpaint)
    pytest -m slow               # real LaMa (+ epubcheck if installed)

## Languages beyond Latin
Mistral OCR reads Indic and many other scripts natively. Point `--font` at a face that
covers the script and the EPUB embeds the right glyphs:

    pdf2fxl book.pdf -o out/ --title "..." --font assets/fonts/NotoSerifDevanagari-Regular.ttf   # Hindi
    pdf2fxl book.pdf -o out/ --title "..." --font assets/fonts/NotoSerifOriya-Regular.ttf         # Odia

The EPUB embeds the font, so it renders anywhere. PPTX only *names* the font (the format
can't embed fonts), so a PPTX renders faithfully only where that font is installed.

## License
Project code: MIT — see [LICENSE](LICENSE).

Bundled fonts: the [Noto](https://fonts.google.com/noto) fonts in `assets/fonts/`
(Noto Serif, Noto Serif Devanagari, Noto Serif Oriya) are © The Noto Project Authors,
licensed under the SIL Open Font License 1.1 — see
[assets/fonts/NOTICE.md](assets/fonts/NOTICE.md) and [assets/fonts/OFL.txt](assets/fonts/OFL.txt).

## Known quality caveats
- On watercolor-heavy pages where text overlaps detailed artwork, LaMa may leave smudges or produce a blurry patch rather than a clean fill — this is expected behaviour of the inpainting backend on CPU.
- On pages where the text area covers most of the page (e.g. a half-page text block sitting on a complex illustration), Mistral OCR may return a single block spanning the full page bounding box rather than individual paragraphs; text content is still extracted correctly.
- OCR blocks do not carry per-block confidence scores by default (the Mistral API only populates these when `confidence_scores_granularity` is explicitly set); the parser defaults to confidence 1.0 in that case.
