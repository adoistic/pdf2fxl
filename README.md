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

## Pipeline
0. Ingest & trim (PyMuPDF) · 1. OCR+layout (Mistral OCR 4) · 1.5 text mask + style ·
2. Inpaint (LaMa) · 3. Fonts · 4. Render EPUB + PPTX. A per-page JSON is the shared contract.

## Tests
    pytest -q -m 'not slow'      # fast, deterministic (fakes for OCR + inpaint)
    pytest -m slow               # real LaMa (+ epubcheck if installed)

## License
MIT — see [LICENSE](LICENSE). The embedded [Noto Serif](https://fonts.google.com/noto)
font is licensed separately under the SIL Open Font License 1.1.

## Known quality caveats
- On watercolor-heavy pages where text overlaps detailed artwork, LaMa may leave smudges or produce a blurry patch rather than a clean fill — this is expected behaviour of the inpainting backend on CPU.
- On pages where the text area covers most of the page (e.g. a half-page text block sitting on a complex illustration), Mistral OCR may return a single block spanning the full page bounding box rather than individual paragraphs; text content is still extracted correctly.
- OCR blocks do not carry per-block confidence scores by default (the Mistral API only populates these when `confidence_scores_granularity` is explicitly set); the parser defaults to confidence 1.0 in that case.
