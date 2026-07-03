# pdf2fxl Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fully-automated Python CLI (`pdf2fxl`) that converts image-only picture-book PDFs into a fixed-layout EPUB3 and a PPTX, with printed text erased from the art (LaMa inpainting) and replaced by real editable text placed by Mistral OCR 4 block coordinates.

**Architecture:** A 5-stage pipeline (ingest/trim → Mistral OCR 4 → local text-mask+style → LaMa inpaint → render) where a per-page JSON is the shared contract that both the EPUB and PPTX renderers consume. Each stage is a focused module with a pure, unit-testable core; external/heavy dependencies (Mistral API, LaMa model) sit behind thin wrappers that tests replace with fixtures/fakes.

**Tech Stack:** Python 3.11+, PyMuPDF (fitz), mistralai, OpenCV (headless) + NumPy, Pillow, simple-lama-inpainting (LaMa), python-pptx, lxml, click, pytest.

---

## File Structure

```
pyproject.toml                     # project metadata, deps, console_script entry
README.md
assets/fonts/NotoSerif-Regular.ttf # embedded EPUB font (Latin, v1)
src/pdf2fxl/
  __init__.py
  models.py        # Block, Page dataclasses + JSON (de)serialization  [the contract]
  config.py        # Config dataclass + defaults
  ingest.py        # Stage 0: rasterize PDF page + trim crop marks/slug
  ocr.py           # Stage 1: Mistral OCR 4 call (wrapper) + block parse/filter (pure)
  textmask.py      # Stage 1.5: dark-text mask + font_px/color/align estimation
  inpaint.py       # Stage 2: page mask build + pluggable inpainter (LaMa default)
  style.py         # Stage 3: script -> font map
  render_epub.py   # Stage 4a: fixed-layout EPUB3 writer
  render_pptx.py   # Stage 4b: PPTX writer
  pipeline.py      # orchestrates stages 0..4 for a whole book
  cli.py           # click entry: pdf2fxl <book.pdf> -o out/
tests/
  conftest.py      # shared fixtures (synthetic images, fake inpainter, sample OCR json)
  test_models.py test_config.py test_ingest.py test_ocr.py test_textmask.py
  test_inpaint.py test_style.py test_render_epub.py test_render_pptx.py
  test_pipeline.py test_cli.py
```

**Responsibilities are split by stage, not layer.** `models.py` is imported by every stage and must stay dependency-free (stdlib only). Heavy imports (`torch`/`simple_lama_inpainting`) are lazy-loaded inside `inpaint.LamaInpainter.__init__` so the rest of the test suite never pulls in torch.

**Conventions used throughout:**
- Images are handled as OpenCV **BGR** `np.uint8` arrays until a renderer needs a file.
- `bbox` is always `(x, y, w, h)` in **pixels on the trimmed page**.
- Masks are single-channel `uint8`, `255` = text/inpaint, `0` = keep.

---

## Task 1: Project scaffold

**Files:**
- Create: `pyproject.toml`
- Create: `src/pdf2fxl/__init__.py`
- Create: `tests/conftest.py`
- Create: `.gitignore`

- [ ] **Step 1: Create `pyproject.toml`**

```toml
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "pdf2fxl"
version = "0.1.0"
description = "Convert image-only picture-book PDFs into fixed-layout EPUB + PPTX with editable OCR text."
requires-python = ">=3.11"
dependencies = [
  "pymupdf>=1.24",
  "mistralai>=1.5",
  "opencv-python-headless>=4.9",
  "numpy>=1.26",
  "pillow>=10.0",
  "simple-lama-inpainting>=0.1.2",
  "python-pptx>=1.0",
  "lxml>=5.0",
  "click>=8.1",
]

[project.optional-dependencies]
dev = ["pytest>=8.0"]

[project.scripts]
pdf2fxl = "pdf2fxl.cli:main"

[tool.hatch.build.targets.wheel]
packages = ["src/pdf2fxl"]

[tool.pytest.ini_options]
pythonpath = ["src"]
markers = ["slow: exercises the real LaMa model or epubcheck (deselect with -m 'not slow')"]
```

- [ ] **Step 2: Create `src/pdf2fxl/__init__.py`**

```python
__version__ = "0.1.0"
```

- [ ] **Step 3: Create `.gitignore`**

```
__pycache__/
*.pyc
.pytest_cache/
out/
*.egg-info/
.venv/
```

- [ ] **Step 4: Create empty `tests/conftest.py`**

```python
# Shared fixtures are added by later tasks.
```

- [ ] **Step 5: Install and verify the toolchain**

Run: `python -m venv .venv && . .venv/bin/activate && pip install -e '.[dev]'`
Then: `pytest -q`
Expected: `no tests ran` (exit 5) — confirms pytest + pythonpath resolve.

- [ ] **Step 6: Commit**

```bash
git add pyproject.toml src/pdf2fxl/__init__.py tests/conftest.py .gitignore
git commit -m "chore: scaffold pdf2fxl package"
```

---

## Task 2: Data models (the JSON contract)

**Files:**
- Create: `src/pdf2fxl/models.py`
- Test: `tests/test_models.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_models.py
from pdf2fxl.models import Block, Page

def test_page_json_roundtrip():
    page = Page(
        index=7, page_size_px=(2048, 1536),
        background="page-07-clean.png", original="page-07.png",
        blocks=[Block(type="text", bbox=(10.0, 20.0, 300.0, 80.0),
                      text="Anita was a painter.", font_px=34.0,
                      color="#1a1a1a", align="left", reading_order=0, confidence=0.98)],
    )
    restored = Page.from_json(page.to_json())
    assert restored == page
    assert restored.blocks[0].bbox == (10.0, 20.0, 300.0, 80.0)

def test_empty_blocks_roundtrip():
    page = Page(index=0, page_size_px=(100, 100),
                background="b.png", original="o.png", blocks=[])
    assert Page.from_json(page.to_json()) == page
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_models.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pdf2fxl.models'`

- [ ] **Step 3: Write minimal implementation**

```python
# src/pdf2fxl/models.py
from __future__ import annotations
from dataclasses import dataclass, field
from typing import List, Tuple
import json


@dataclass
class Block:
    type: str
    bbox: Tuple[float, float, float, float]  # x, y, w, h (px on trimmed page)
    text: str
    script: str = "Latn"
    font_px: float = 0.0
    color: str = "#000000"
    align: str = "left"
    reading_order: int = 0
    confidence: float = 1.0


@dataclass
class Page:
    index: int
    page_size_px: Tuple[int, int]
    background: str
    original: str
    blocks: List[Block] = field(default_factory=list)

    def to_json(self) -> str:
        return json.dumps({
            "index": self.index,
            "page_size_px": list(self.page_size_px),
            "background": self.background,
            "original": self.original,
            "blocks": [{
                "type": b.type, "bbox": list(b.bbox), "text": b.text,
                "script": b.script, "font_px": b.font_px, "color": b.color,
                "align": b.align, "reading_order": b.reading_order,
                "confidence": b.confidence,
            } for b in self.blocks],
        }, indent=2, ensure_ascii=False)

    @staticmethod
    def from_json(s: str) -> "Page":
        d = json.loads(s)
        return Page(
            index=d["index"],
            page_size_px=tuple(d["page_size_px"]),
            background=d["background"],
            original=d["original"],
            blocks=[Block(
                type=b["type"], bbox=tuple(b["bbox"]), text=b["text"],
                script=b.get("script", "Latn"), font_px=b.get("font_px", 0.0),
                color=b.get("color", "#000000"), align=b.get("align", "left"),
                reading_order=b.get("reading_order", 0),
                confidence=b.get("confidence", 1.0),
            ) for b in d["blocks"]],
        )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_models.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add src/pdf2fxl/models.py tests/test_models.py
git commit -m "feat: add Page/Block models with JSON round-trip"
```

---

## Task 3: Config

**Files:**
- Create: `src/pdf2fxl/config.py`
- Test: `tests/test_config.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_config.py
from pdf2fxl.config import Config

def test_defaults():
    c = Config()
    assert c.zoom == 300 / 72          # ~4.1667, i.e. 300 DPI render
    assert c.ocr_model == "mistral-ocr-4-0"
    assert "footer" in c.drop_block_types
    assert "text" in c.keep_block_types
    assert c.font_map["Latn"] == "Noto Serif"
    assert c.mask_dilate_px == 2
    assert c.trim_strategy == "content"

def test_override():
    c = Config(zoom=2.0, mask_dilate_px=5)
    assert c.zoom == 2.0 and c.mask_dilate_px == 5
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_config.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pdf2fxl.config'`

- [ ] **Step 3: Write minimal implementation**

```python
# src/pdf2fxl/config.py
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Dict, Tuple


def _default_font_map() -> Dict[str, str]:
    return {"Latn": "Noto Serif"}


@dataclass
class Config:
    zoom: float = 300 / 72                       # render at ~300 DPI
    ocr_model: str = "mistral-ocr-4-0"
    keep_block_types: Tuple[str, ...] = ("text", "title", "list", "caption")
    drop_block_types: Tuple[str, ...] = ("header", "footer", "page_number", "image")
    dark_thresh: int = 128                        # text-pixel threshold (grayscale)
    mask_dilate_px: int = 2
    trim_strategy: str = "content"                # "content" | "trimbox" | "none"
    font_map: Dict[str, str] = field(default_factory=_default_font_map)
    pptx_aspect: Tuple[int, int] = (4, 3)         # deck aspect ratio (w, h)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_config.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add src/pdf2fxl/config.py tests/test_config.py
git commit -m "feat: add Config with pipeline defaults"
```

---

## Task 4: Ingest & trim (Stage 0)

**Files:**
- Create: `src/pdf2fxl/ingest.py`
- Test: `tests/test_ingest.py`
- Modify: `tests/conftest.py`

- [ ] **Step 1: Add a synthetic-page fixture to `tests/conftest.py`**

```python
# tests/conftest.py  (append)
import numpy as np
import pytest


@pytest.fixture
def page_with_marks():
    """White page: big gray art block, thin black crop marks in the margins,
    a small black slug blob at the bottom. content_bbox() should return the art block."""
    img = np.full((400, 500, 3), 255, np.uint8)     # white BGR
    img[40:340, 60:440] = (200, 200, 200)           # art region -> (60,40)..(440,340)
    img[8:9, 8:28] = 0; img[8:28, 8:9] = 0          # top-left crop mark (thin)
    img[391:392, 470:495] = 0                       # bottom-right crop mark (thin)
    img[375:385, 200:300] = 0                       # slug blob (short, thin)
    return img
```

- [ ] **Step 2: Write the failing test**

```python
# tests/test_ingest.py
import numpy as np
from pdf2fxl.ingest import content_bbox, trim_page

def test_content_bbox_ignores_thin_marks(page_with_marks):
    x0, y0, x1, y1 = content_bbox(page_with_marks, white_thresh=245, open_ksize=15)
    # Should snap to the art block (60,40)-(440,340), not the crop marks or slug.
    assert abs(x0 - 60) <= 2 and abs(y0 - 40) <= 2
    assert abs(x1 - 440) <= 2 and abs(y1 - 340) <= 2

def test_trim_page_crops_to_content(page_with_marks):
    out = trim_page(page_with_marks, trim=None)
    assert out.shape[0] == 300 and out.shape[1] == 380  # 340-40, 440-60 (±0)

def test_trim_page_respects_explicit_box(page_with_marks):
    out = trim_page(page_with_marks, trim=(10, 10, 110, 60))
    assert out.shape[0] == 50 and out.shape[1] == 100
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pytest tests/test_ingest.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pdf2fxl.ingest'`

- [ ] **Step 4: Write minimal implementation**

```python
# src/pdf2fxl/ingest.py
from __future__ import annotations
from typing import Optional, Tuple
import cv2
import numpy as np


def content_bbox(img_bgr: np.ndarray, white_thresh: int = 245,
                 open_ksize: int = 15) -> Tuple[int, int, int, int]:
    """Largest non-white region after morphological opening (drops thin crop marks/slug)."""
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    nonwhite = (gray < white_thresh).astype(np.uint8) * 255
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (open_ksize, open_ksize))
    opened = cv2.morphologyEx(nonwhite, cv2.MORPH_OPEN, kernel)
    n, _, stats, _ = cv2.connectedComponentsWithStats(opened, connectivity=8)
    if n <= 1:
        return (0, 0, img_bgr.shape[1], img_bgr.shape[0])
    i = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    x = int(stats[i, cv2.CC_STAT_LEFT]); y = int(stats[i, cv2.CC_STAT_TOP])
    w = int(stats[i, cv2.CC_STAT_WIDTH]); h = int(stats[i, cv2.CC_STAT_HEIGHT])
    return (x, y, x + w, y + h)


def trim_page(img_bgr: np.ndarray,
              trim: Optional[Tuple[int, int, int, int]]) -> np.ndarray:
    if trim is None:
        trim = content_bbox(img_bgr)
    x0, y0, x1, y1 = trim
    return img_bgr[y0:y1, x0:x1].copy()


def rasterize_page(pdf_path: str, index: int, zoom: float) -> np.ndarray:
    """Render one PDF page to a BGR uint8 array at the given zoom."""
    import fitz
    doc = fitz.open(pdf_path)
    try:
        pix = doc[index].get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
        buf = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n)
        return cv2.cvtColor(buf, cv2.COLOR_RGB2BGR)
    finally:
        doc.close()


def page_count(pdf_path: str) -> int:
    import fitz
    doc = fitz.open(pdf_path)
    try:
        return doc.page_count
    finally:
        doc.close()
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pytest tests/test_ingest.py -v`
Expected: PASS (3 passed)

- [ ] **Step 6: Add a real-PDF rasterize smoke test (marked slow)**

```python
# tests/test_ingest.py  (append)
import os, pytest
from pdf2fxl.ingest import rasterize_page, page_count

REAL_PDF = "/Users/siraj/Downloads/Little_Elephant.pdf"

@pytest.mark.slow
@pytest.mark.skipif(not os.path.exists(REAL_PDF), reason="sample PDF not present")
def test_rasterize_real_pdf():
    assert page_count(REAL_PDF) == 20
    img = rasterize_page(REAL_PDF, 0, zoom=2.0)
    assert img.ndim == 3 and img.shape[2] == 3 and img.shape[0] > 100
```

Run: `pytest tests/test_ingest.py -v -m slow`
Expected: PASS (or SKIP if the sample PDF is absent).

- [ ] **Step 7: Commit**

```bash
git add src/pdf2fxl/ingest.py tests/test_ingest.py tests/conftest.py
git commit -m "feat: add Stage 0 ingest (rasterize + content-aware trim)"
```

---

## Task 5: OCR wrapper + block parser (Stage 1)

**Files:**
- Create: `src/pdf2fxl/ocr.py`
- Test: `tests/test_ocr.py`
- Modify: `tests/conftest.py`

The network call (`run_ocr`) is a thin wrapper exercised only by a slow integration test. The **pure parser** (`parse_ocr_response`) is fully unit-tested with a fixture that mirrors the documented OCR-4 schema.

- [ ] **Step 1: Add a sample OCR-response fixture to `tests/conftest.py`**

```python
# tests/conftest.py  (append)
@pytest.fixture
def ocr_response():
    """Shape mirrors Mistral OCR 4 `blocks` output; coords are in the returned
    `dimensions` space (here 1000x750), to be scaled to page_size_px."""
    return {"pages": [{
        "index": 0,
        "dimensions": {"width": 1000, "height": 750},
        "markdown": "# ...",
        "blocks": [
            {"type": "text", "top_left_x": 100, "top_left_y": 200,
             "bottom_right_x": 400, "bottom_right_y": 280,
             "content": "Anita was a painter.", "confidence": 0.98},
            {"type": "footer", "top_left_x": 20, "top_left_y": 730,
             "bottom_right_x": 300, "bottom_right_y": 745,
             "content": "Book-English.indd  3   10/19/2022", "confidence": 0.9},
            {"type": "image", "top_left_x": 0, "top_left_y": 0,
             "bottom_right_x": 600, "bottom_right_y": 500, "content": ""},
        ],
    }]}
```

- [ ] **Step 2: Write the failing test**

```python
# tests/test_ocr.py
from pdf2fxl.ocr import parse_ocr_response
from pdf2fxl.config import Config

def test_parser_keeps_text_drops_footer_and_image(ocr_response):
    cfg = Config()
    blocks = parse_ocr_response(ocr_response, page_size_px=(2000, 1500), cfg=cfg)
    assert len(blocks) == 1
    b = blocks[0]
    assert b.type == "text"
    assert b.text == "Anita was a painter."
    # 1000x750 -> 2000x1500 is a 2x scale; box (100,200,300,80) -> (200,400,600,160)
    assert b.bbox == (200.0, 400.0, 600.0, 160.0)
    assert b.reading_order == 0
    assert b.confidence == 0.98

def test_parser_assigns_sequential_reading_order(ocr_response):
    ocr_response["pages"][0]["blocks"].append(
        {"type": "text", "top_left_x": 100, "top_left_y": 300,
         "bottom_right_x": 400, "bottom_right_y": 360, "content": "Second."})
    blocks = parse_ocr_response(ocr_response, page_size_px=(1000, 750), cfg=Config())
    assert [b.reading_order for b in blocks] == [0, 1]
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pytest tests/test_ocr.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pdf2fxl.ocr'`

- [ ] **Step 4: Write minimal implementation**

```python
# src/pdf2fxl/ocr.py
from __future__ import annotations
from typing import List, Tuple
import base64
import cv2
import numpy as np

from .models import Block
from .config import Config


def parse_ocr_response(resp: dict, page_size_px: Tuple[int, int],
                       cfg: Config) -> List[Block]:
    """Convert a Mistral OCR-4 response into ordered, filtered Blocks with pixel bboxes."""
    page = resp["pages"][0]
    dims = page["dimensions"]
    sx = page_size_px[0] / dims["width"]
    sy = page_size_px[1] / dims["height"]
    blocks: List[Block] = []
    order = 0
    for b in page.get("blocks", []):
        t = b.get("type", "text")
        if t in cfg.drop_block_types:
            continue
        if cfg.keep_block_types and t not in cfg.keep_block_types:
            continue
        x0 = b["top_left_x"] * sx; y0 = b["top_left_y"] * sy
        x1 = b["bottom_right_x"] * sx; y1 = b["bottom_right_y"] * sy
        blocks.append(Block(
            type=t, bbox=(x0, y0, x1 - x0, y1 - y0),
            text=(b.get("content") or "").strip(),
            reading_order=order, confidence=float(b.get("confidence", 1.0)),
        ))
        order += 1
    return blocks


def run_ocr(image_bgr: np.ndarray, cfg: Config, api_key: str) -> dict:
    """Send one page image to Mistral OCR 4 and return the raw response as a dict.

    NOTE: OCR-4 kwargs (include_blocks, extract_footer) are passed defensively;
    confirm exact names against the installed SDK on first run.
    """
    from mistralai import Mistral
    ok, png = cv2.imencode(".png", image_bgr)
    if not ok:
        raise RuntimeError("failed to PNG-encode page image")
    data_url = "data:image/png;base64," + base64.b64encode(png.tobytes()).decode()
    client = Mistral(api_key=api_key)
    resp = client.ocr.process(
        model=cfg.ocr_model,
        document={"type": "image_url", "image_url": data_url},
        include_blocks=True,
        extract_footer=True,
        include_image_base64=False,
    )
    return resp.model_dump() if hasattr(resp, "model_dump") else dict(resp)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pytest tests/test_ocr.py -v`
Expected: PASS (2 passed)

- [ ] **Step 6: Commit**

```bash
git add src/pdf2fxl/ocr.py tests/test_ocr.py tests/conftest.py
git commit -m "feat: add Stage 1 OCR parser + Mistral wrapper"
```

---

## Task 6: Text mask + style estimation (Stage 1.5)

**Files:**
- Create: `src/pdf2fxl/textmask.py`
- Test: `tests/test_textmask.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_textmask.py
import numpy as np
from pdf2fxl.models import Block
from pdf2fxl.textmask import (block_text_mask, estimate_font_px,
                              estimate_color, estimate_align, build_page_mask)

def _canvas_with_glyphs():
    """White 200x300 image; three black 'glyph' bars height=20 at the left of a block."""
    img = np.full((200, 300, 3), 255, np.uint8)
    for gx in (30, 55, 80):                 # 3 bars, width 10, height 20, top=100
        img[100:120, gx:gx + 10] = 0
    return img

def test_block_text_mask_marks_dark_pixels():
    img = _canvas_with_glyphs()
    m = block_text_mask(img, bbox=(20, 90, 120, 40), dark_thresh=128)
    assert m.shape == (40, 120)
    assert m.max() == 255 and m.min() == 0
    assert int((m > 0).sum()) == 3 * 10 * 20   # exactly the three bars

def test_estimate_font_px_is_glyph_height():
    img = _canvas_with_glyphs()
    m = block_text_mask(img, bbox=(20, 90, 120, 40))
    assert estimate_font_px(m) == 20.0

def test_estimate_color_black_text():
    img = _canvas_with_glyphs()
    bbox = (20, 90, 120, 40)
    m = block_text_mask(img, bbox)
    assert estimate_color(img, bbox, m) == "#000000"

def test_estimate_align_left():
    img = _canvas_with_glyphs()
    bbox = (20, 90, 120, 40)                 # glyphs start near left edge of block
    m = block_text_mask(img, bbox)
    assert estimate_align(m, block_w=120) == "left"

def test_build_page_mask_dilates_union():
    img = _canvas_with_glyphs()
    blocks = [Block(type="text", bbox=(20, 90, 120, 40), text="x")]
    mask = build_page_mask(img, blocks, dark_thresh=128, dilate_px=1)
    assert mask.shape == (200, 300)
    assert int((mask > 0).sum()) > 3 * 10 * 20   # dilated, so larger than raw glyphs
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_textmask.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pdf2fxl.textmask'`

- [ ] **Step 3: Write minimal implementation**

```python
# src/pdf2fxl/textmask.py
from __future__ import annotations
from typing import List, Tuple
import cv2
import numpy as np

from .models import Block


def _ints(bbox: Tuple[float, float, float, float]) -> Tuple[int, int, int, int]:
    x, y, w, h = bbox
    return int(round(x)), int(round(y)), int(round(w)), int(round(h))


def block_text_mask(img_bgr: np.ndarray, bbox, dark_thresh: int = 128) -> np.ndarray:
    """ROI-local mask: dark pixels -> 255 (text), else 0."""
    x, y, w, h = _ints(bbox)
    roi = img_bgr[y:y + h, x:x + w]
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    _, m = cv2.threshold(gray, dark_thresh, 255, cv2.THRESH_BINARY_INV)
    return m


def estimate_font_px(mask: np.ndarray) -> float:
    """Median connected-component height ~= glyph height."""
    n, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    heights = [int(stats[i, cv2.CC_STAT_HEIGHT]) for i in range(1, n)]
    return float(np.median(heights)) if heights else 0.0


def estimate_color(img_bgr: np.ndarray, bbox, mask: np.ndarray) -> str:
    x, y, w, h = _ints(bbox)
    roi = img_bgr[y:y + h, x:x + w]
    pix = roi[mask > 0]
    if len(pix) == 0:
        return "#000000"
    b, g, r = (int(v) for v in np.median(pix, axis=0))
    return "#{:02x}{:02x}{:02x}".format(r, g, b)


def estimate_align(mask: np.ndarray, block_w: int) -> str:
    cols = np.where(mask.sum(axis=0) > 0)[0]
    if len(cols) == 0:
        return "left"
    left = int(cols[0])
    right = int(mask.shape[1] - 1 - cols[-1])
    if abs(left - right) <= 0.1 * block_w:
        return "center"
    return "left" if left <= right else "right"


def build_page_mask(img_bgr: np.ndarray, blocks: List[Block],
                    dark_thresh: int = 128, dilate_px: int = 2) -> np.ndarray:
    H, W = img_bgr.shape[:2]
    mask = np.zeros((H, W), np.uint8)
    for b in blocks:
        x, y, w, h = _ints(b.bbox)
        m = block_text_mask(img_bgr, b.bbox, dark_thresh)
        region = mask[y:y + h, x:x + w]
        mask[y:y + h, x:x + w] = np.maximum(region, m)
    if dilate_px > 0:
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * dilate_px + 1, 2 * dilate_px + 1))
        mask = cv2.dilate(mask, k)
    return mask


def annotate_style(img_bgr: np.ndarray, block: Block, dark_thresh: int = 128) -> Block:
    """Fill font_px/color/align on a copy of `block` from its pixels."""
    m = block_text_mask(img_bgr, block.bbox, dark_thresh)
    block.font_px = estimate_font_px(m)
    block.color = estimate_color(img_bgr, block.bbox, m)
    block.align = estimate_align(m, int(round(block.bbox[2])))
    return block
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_textmask.py -v`
Expected: PASS (5 passed)

- [ ] **Step 5: Commit**

```bash
git add src/pdf2fxl/textmask.py tests/test_textmask.py
git commit -m "feat: add Stage 1.5 text mask + style estimation"
```

---

## Task 7: Inpaint (Stage 2)

**Files:**
- Create: `src/pdf2fxl/inpaint.py`
- Test: `tests/test_inpaint.py`
- Modify: `tests/conftest.py`

`apply_inpainting` is tested with a deterministic `FakeInpainter`; the real `LamaInpainter` (torch) is lazy and exercised only by a slow test.

- [ ] **Step 1: Add a FakeInpainter fixture to `tests/conftest.py`**

```python
# tests/conftest.py  (append)
from PIL import Image


class FakeInpainter:
    """Deterministic stand-in: paints masked pixels solid red, leaves the rest."""
    def __call__(self, image: Image.Image, mask: Image.Image) -> Image.Image:
        import numpy as np
        rgb = np.array(image.convert("RGB"))
        m = np.array(mask.convert("L")) > 0
        rgb[m] = (255, 0, 0)
        return Image.fromarray(rgb)


@pytest.fixture
def fake_inpainter():
    return FakeInpainter()
```

- [ ] **Step 2: Write the failing test**

```python
# tests/test_inpaint.py
import numpy as np
from pdf2fxl.inpaint import apply_inpainting

def test_apply_inpainting_changes_only_masked(fake_inpainter):
    img = np.full((10, 10, 3), 200, np.uint8)   # gray BGR
    mask = np.zeros((10, 10), np.uint8)
    mask[2:5, 2:5] = 255
    out = apply_inpainting(img, mask, fake_inpainter)
    assert out.shape == img.shape
    # masked region became red -> in BGR that's (0,0,255)
    assert (out[2:5, 2:5] == (0, 0, 255)).all()
    # a pixel outside the mask is unchanged
    assert (out[0, 0] == (200, 200, 200)).all()
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pytest tests/test_inpaint.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pdf2fxl.inpaint'`

- [ ] **Step 4: Write minimal implementation**

```python
# src/pdf2fxl/inpaint.py
from __future__ import annotations
from typing import Protocol
import cv2
import numpy as np
from PIL import Image


class Inpainter(Protocol):
    def __call__(self, image: Image.Image, mask: Image.Image) -> Image.Image: ...


class LamaInpainter:
    """LaMa via simple-lama-inpainting. Torch is imported lazily."""
    def __init__(self) -> None:
        from simple_lama_inpainting import SimpleLama
        self._lama = SimpleLama()

    def __call__(self, image: Image.Image, mask: Image.Image) -> Image.Image:
        return self._lama(image.convert("RGB"), mask.convert("L"))


def apply_inpainting(image_bgr: np.ndarray, mask: np.ndarray,
                     inpainter: Inpainter) -> np.ndarray:
    """Run an inpainter over a BGR array + single-channel mask; return BGR array."""
    img_rgb = Image.fromarray(cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB))
    out = inpainter(img_rgb, Image.fromarray(mask))
    return cv2.cvtColor(np.array(out.convert("RGB")), cv2.COLOR_RGB2BGR)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pytest tests/test_inpaint.py -v`
Expected: PASS (1 passed)

- [ ] **Step 6: Add a real-LaMa slow test**

```python
# tests/test_inpaint.py  (append)
import pytest
from pdf2fxl.inpaint import LamaInpainter, apply_inpainting

@pytest.mark.slow
def test_real_lama_runs():
    img = np.full((64, 64, 3), 180, np.uint8)
    img[28:36, 10:54] = 0                 # a dark "text" bar to erase
    mask = np.zeros((64, 64), np.uint8); mask[28:36, 10:54] = 255
    out = apply_inpainting(img, mask, LamaInpainter())
    assert out.shape == img.shape
    assert out[28:36, 10:54].mean() > 100   # bar lightened toward background
```

Run: `pytest tests/test_inpaint.py -v -m slow`
Expected: PASS (downloads the LaMa model on first run).

- [ ] **Step 7: Commit**

```bash
git add src/pdf2fxl/inpaint.py tests/test_inpaint.py tests/conftest.py
git commit -m "feat: add Stage 2 inpaint (pluggable, LaMa default)"
```

---

## Task 8: Style / font map (Stage 3)

**Files:**
- Create: `src/pdf2fxl/style.py`
- Test: `tests/test_style.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_style.py
from pdf2fxl.config import Config
from pdf2fxl.style import font_for

def test_font_for_known_script():
    assert font_for("Latn", Config()) == "Noto Serif"

def test_font_for_unknown_script_falls_back_to_latin():
    assert font_for("Taml", Config()) == "Noto Serif"   # v1: Latin fallback
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_style.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pdf2fxl.style'`

- [ ] **Step 3: Write minimal implementation**

```python
# src/pdf2fxl/style.py
from __future__ import annotations
from .config import Config


def font_for(script: str, cfg: Config) -> str:
    return cfg.font_map.get(script, cfg.font_map["Latn"])
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_style.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add src/pdf2fxl/style.py tests/test_style.py
git commit -m "feat: add Stage 3 script->font mapping"
```

---

## Task 9: EPUB renderer (Stage 4a)

**Files:**
- Create: `src/pdf2fxl/render_epub.py`
- Create: `assets/fonts/NotoSerif-Regular.ttf` (download step below)
- Test: `tests/test_render_epub.py`

- [ ] **Step 1: Add the Noto Serif font asset**

Run:
```bash
mkdir -p assets/fonts
curl -L -o assets/fonts/NotoSerif-Regular.ttf \
  "https://github.com/notofonts/notofonts.github.io/raw/main/fonts/NotoSerif/hinted/ttf/NotoSerif-Regular.ttf"
```
Expected: a ~400KB TTF at `assets/fonts/NotoSerif-Regular.ttf`. Verify: `file assets/fonts/NotoSerif-Regular.ttf` → "TrueType Font data".

- [ ] **Step 2: Write the failing test**

```python
# tests/test_render_epub.py
import zipfile
from lxml import etree
from pathlib import Path
from PIL import Image
from pdf2fxl.models import Page, Block
from pdf2fxl.render_epub import write_epub

def _one_page(tmp_path):
    bg = tmp_path / "page-00-clean.png"
    Image.new("RGB", (200, 150), (255, 255, 255)).save(bg)
    page = Page(index=0, page_size_px=(200, 150), background=str(bg), original=str(bg),
                blocks=[Block(type="text", bbox=(20, 30, 100, 40),
                              text="Hello world", font_px=18, color="#111111",
                              align="left", reading_order=0)])
    return page

def test_write_epub_is_valid_zip_with_mimetype_first(tmp_path):
    out = tmp_path / "book.epub"
    write_epub([_one_page(tmp_path)], out, title="Test", language="en",
               font_path="assets/fonts/NotoSerif-Regular.ttf")
    with zipfile.ZipFile(out) as z:
        names = z.namelist()
        assert names[0] == "mimetype"
        info = z.getinfo("mimetype")
        assert info.compress_type == zipfile.ZIP_STORED
        assert z.read("mimetype") == b"application/epub+zip"
        assert "OEBPS/content.opf" in names
        assert "OEBPS/page-00.xhtml" in names
        assert "OEBPS/fonts/NotoSerif-Regular.ttf" in names

def test_page_xhtml_has_viewport_and_positioned_text(tmp_path):
    out = tmp_path / "book.epub"
    write_epub([_one_page(tmp_path)], out, title="Test", language="en",
               font_path="assets/fonts/NotoSerif-Regular.ttf")
    with zipfile.ZipFile(out) as z:
        xhtml = z.read("OEBPS/page-00.xhtml").decode()
    root = etree.fromstring(xhtml.encode())
    ns = {"x": "http://www.w3.org/1999/xhtml"}
    meta = root.find(".//x:meta[@name='viewport']", ns)
    assert meta.get("content") == "width=200, height=150"
    div = root.find(".//x:div[@class='tb']", ns)
    assert "Hello world" in "".join(div.itertext())
    style = div.get("style")
    assert "left:10.000%" in style and "top:20.000%" in style   # 20/200, 30/150
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pytest tests/test_render_epub.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pdf2fxl.render_epub'`

- [ ] **Step 4: Write minimal implementation**

```python
# src/pdf2fxl/render_epub.py
from __future__ import annotations
from pathlib import Path
from typing import List
import html
import shutil
import zipfile

from .models import Page

CONTAINER_XML = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf"
     media-type="application/oebps-package+xml"/></rootfiles>
</container>
"""

PAGE_CSS = """@font-face { font-family: "Noto Serif";
  src: url("../fonts/NotoSerif-Regular.ttf"); }
html, body { margin: 0; padding: 0; }
.page { position: relative; width: 100%; height: 100%; }
.bg { position: absolute; top: 0; left: 0; width: 100%; height: 100%; }
.tb { position: absolute; margin: 0; font-family: "Noto Serif", serif;
  line-height: 1.15; overflow: hidden; }
"""


def _page_xhtml(page: Page, img_name: str) -> str:
    w, h = page.page_size_px
    parts = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<!DOCTYPE html>',
        '<html xmlns="http://www.w3.org/1999/xhtml" '
        'xmlns:epub="http://www.idpf.org/2007/ops">',
        '<head>', '<meta charset="utf-8"/>',
        f'<meta name="viewport" content="width={w}, height={h}"/>',
        '<link rel="stylesheet" type="text/css" href="styles/page.css"/>',
        '</head>', '<body>', '<div class="page">',
        f'<img class="bg" src="images/{img_name}" alt=""/>',
    ]
    for b in sorted(page.blocks, key=lambda z: z.reading_order):
        x, y, bw, bh = b.bbox
        style = (
            f"left:{x / w * 100:.3f}%;top:{y / h * 100:.3f}%;"
            f"width:{bw / w * 100:.3f}%;height:{bh / h * 100:.3f}%;"
            f"font-size:{b.font_px:.2f}px;color:{b.color};text-align:{b.align};"
        )
        parts.append(f'<div class="tb" style="{style}">{html.escape(b.text)}</div>')
    parts += ['</div>', '</body>', '</html>']
    return "\n".join(parts)


def _opf(pages: List[Page], title: str, language: str, font_name: str) -> str:
    manifest = [
        '<item id="css" href="styles/page.css" media-type="text/css"/>',
        f'<item id="font" href="fonts/{font_name}" '
        'media-type="application/font-sfnt"/>',
        '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" '
        'properties="nav"/>',
    ]
    spine = []
    for i, _ in enumerate(pages):
        manifest.append(f'<item id="img{i}" href="images/page-{i:02d}.png" '
                        'media-type="image/png"/>')
        props = ' properties="cover-image"' if i == 0 else ''
        manifest[-1] = manifest[-1].replace('/>', f'{props}/>') if i == 0 else manifest[-1]
        manifest.append(f'<item id="pg{i}" href="page-{i:02d}.xhtml" '
                        'media-type="application/xhtml+xml"/>')
        spine.append(f'<itemref idref="pg{i}"/>')
    return f"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid"
         prefix="rendition: http://www.idpf.org/vocab/rendition/#">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:pdf2fxl-{html.escape(title)}</dc:identifier>
    <dc:title>{html.escape(title)}</dc:title>
    <dc:language>{language}</dc:language>
    <meta property="rendition:layout">pre-paginated</meta>
    <meta property="rendition:orientation">landscape</meta>
    <meta property="rendition:spread">both</meta>
  </metadata>
  <manifest>
    {"".join(manifest)}
  </manifest>
  <spine>
    {"".join(spine)}
  </spine>
</package>
"""


def _nav(pages: List[Page], title: str) -> str:
    lis = "".join(f'<li><a href="page-{i:02d}.xhtml">Page {i + 1}</a></li>'
                  for i in range(len(pages)))
    return f"""<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><meta charset="utf-8"/><title>{html.escape(title)}</title></head>
<body><nav epub:type="toc" id="toc"><ol>{lis}</ol></nav></body></html>
"""


def write_epub(pages: List[Page], out_path: Path, title: str, language: str,
               font_path: str) -> Path:
    out_path = Path(out_path)
    font_name = Path(font_path).name
    with zipfile.ZipFile(out_path, "w") as z:
        z.writestr("mimetype", "application/epub+zip", zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", CONTAINER_XML, zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/styles/page.css", PAGE_CSS, zipfile.ZIP_DEFLATED)
        z.write(font_path, f"OEBPS/fonts/{font_name}", zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/content.opf", _opf(pages, title, language, font_name),
                   zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/nav.xhtml", _nav(pages, title), zipfile.ZIP_DEFLATED)
        for i, page in enumerate(pages):
            img_name = f"page-{i:02d}.png"
            z.write(page.background, f"OEBPS/images/{img_name}", zipfile.ZIP_DEFLATED)
            z.writestr(f"OEBPS/page-{i:02d}.xhtml", _page_xhtml(page, img_name),
                       zipfile.ZIP_DEFLATED)
    return out_path
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pytest tests/test_render_epub.py -v`
Expected: PASS (2 passed)

- [ ] **Step 6: (Optional) epubcheck slow test**

```python
# tests/test_render_epub.py  (append)
import os, shutil, subprocess, pytest
@pytest.mark.slow
@pytest.mark.skipif(shutil.which("epubcheck") is None, reason="epubcheck not installed")
def test_epubcheck_passes(tmp_path):
    out = tmp_path / "book.epub"
    write_epub([_one_page(tmp_path)], out, title="Test", language="en",
               font_path="assets/fonts/NotoSerif-Regular.ttf")
    r = subprocess.run(["epubcheck", str(out)], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
```

Run: `pytest tests/test_render_epub.py -v -m slow`
Expected: PASS or SKIP.

- [ ] **Step 7: Commit**

```bash
git add src/pdf2fxl/render_epub.py tests/test_render_epub.py assets/fonts/NotoSerif-Regular.ttf
git commit -m "feat: add Stage 4a fixed-layout EPUB3 renderer"
```

---

## Task 10: PPTX renderer (Stage 4b)

**Files:**
- Create: `src/pdf2fxl/render_pptx.py`
- Test: `tests/test_render_pptx.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_render_pptx.py
from PIL import Image
from pptx import Presentation
from pptx.util import Emu
from pdf2fxl.models import Page, Block
from pdf2fxl.render_pptx import write_pptx

def _one_page(tmp_path):
    bg = tmp_path / "page-00-clean.png"
    Image.new("RGB", (400, 300), (255, 255, 255)).save(bg)
    return Page(index=0, page_size_px=(400, 300), background=str(bg), original=str(bg),
                blocks=[Block(type="text", bbox=(40, 60, 200, 90), text="Hello deck",
                              font_px=24, color="#222222", align="left", reading_order=0)])

def test_pptx_slide_picture_and_textbox(tmp_path):
    out = tmp_path / "book.pptx"
    write_pptx([_one_page(tmp_path)], out, aspect=(4, 3))
    prs = Presentation(str(out))
    assert prs.slide_width == Emu(9144000) and prs.slide_height == Emu(6858000)
    slide = prs.slides[0]
    pics = [s for s in slide.shapes if s.shape_type == 13]        # PICTURE
    boxes = [s for s in slide.shapes if s.has_text_frame]
    assert len(pics) == 1 and len(boxes) == 1
    assert boxes[0].text_frame.text == "Hello deck"
    # left = 40/400 * 9144000 = 914400
    assert abs(boxes[0].left - 914400) < 2000
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_render_pptx.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pdf2fxl.render_pptx'`

- [ ] **Step 3: Write minimal implementation**

```python
# src/pdf2fxl/render_pptx.py
from __future__ import annotations
from pathlib import Path
from typing import List, Tuple
from pptx import Presentation
from pptx.util import Emu, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR

from .models import Page

_EMU_PER_IN = 914400
_ALIGN = {"left": PP_ALIGN.LEFT, "center": PP_ALIGN.CENTER,
          "right": PP_ALIGN.RIGHT, "justify": PP_ALIGN.JUSTIFY}


def _hex_to_rgb(c: str) -> RGBColor:
    c = c.lstrip("#")
    return RGBColor(int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16))


def write_pptx(pages: List[Page], out_path: Path, aspect: Tuple[int, int] = (4, 3),
               font_name: str = "Noto Serif", slide_height_in: float = 7.5) -> Path:
    prs = Presentation()
    aw, ah = aspect
    prs.slide_height = Emu(int(slide_height_in * _EMU_PER_IN))
    prs.slide_width = Emu(int(slide_height_in * aw / ah * _EMU_PER_IN))
    slide_w, slide_h = int(prs.slide_width), int(prs.slide_height)
    slide_h_pt = slide_height_in * 72
    blank = prs.slide_layouts[6]

    for page in pages:
        slide = prs.slides.add_slide(blank)
        slide.shapes.add_picture(page.background, 0, 0, width=slide_w, height=slide_h)
        pw, ph = page.page_size_px
        for b in sorted(page.blocks, key=lambda z: z.reading_order):
            x, y, w, h = b.bbox
            box = slide.shapes.add_textbox(
                Emu(int(x / pw * slide_w)), Emu(int(y / ph * slide_h)),
                Emu(int(w / pw * slide_w)), Emu(int(h / ph * slide_h)))
            tf = box.text_frame
            tf.word_wrap = True
            tf.vertical_anchor = MSO_ANCHOR.TOP
            para = tf.paragraphs[0]
            para.alignment = _ALIGN.get(b.align, PP_ALIGN.LEFT)
            run = para.add_run()
            run.text = b.text
            run.font.name = font_name
            run.font.size = Pt(round(b.font_px / ph * slide_h_pt, 1))
            run.font.color.rgb = _hex_to_rgb(b.color)
    prs.save(str(out_path))
    return Path(out_path)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_render_pptx.py -v`
Expected: PASS (1 passed)

- [ ] **Step 5: Commit**

```bash
git add src/pdf2fxl/render_pptx.py tests/test_render_pptx.py
git commit -m "feat: add Stage 4b PPTX renderer"
```

---

## Task 11: Pipeline orchestration

**Files:**
- Create: `src/pdf2fxl/pipeline.py`
- Test: `tests/test_pipeline.py`

The pipeline is testable end-to-end without the network or LaMa by injecting an OCR function and an inpainter.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_pipeline.py
import numpy as np
from pathlib import Path
from PIL import Image
from pptx import Presentation
import zipfile
from pdf2fxl.config import Config
from pdf2fxl.pipeline import convert_book

def _fake_ocr_fn(response):
    def fn(image_bgr, cfg, api_key):
        return response
    return fn

def test_convert_book_produces_epub_and_pptx(tmp_path, ocr_response, fake_inpainter, monkeypatch):
    # one synthetic PDF page: white with a dark text bar in the text-block region
    import fitz
    pdf = tmp_path / "tiny.pdf"
    doc = fitz.open(); page = doc.new_page(width=500, height=375)  # 4:3
    page.insert_text((60, 120), "Anita was a painter.", fontsize=20)
    doc.save(str(pdf)); doc.close()

    # OCR fixture describes one text block over that region (dims match render size)
    resp = ocr_response
    out_dir = tmp_path / "out"
    epub, pptx = convert_book(
        str(pdf), out_dir, cfg=Config(zoom=2.0, trim_strategy="none"),
        ocr_fn=_fake_ocr_fn(resp), inpainter=fake_inpainter,
        api_key="x", title="Tiny", language="en",
        font_path="assets/fonts/NotoSerif-Regular.ttf")

    assert epub.exists() and pptx.exists()
    with zipfile.ZipFile(epub) as z:
        assert "OEBPS/page-00.xhtml" in z.namelist()
    assert len(Presentation(str(pptx)).slides) == 1
    # intermediate JSON written for inspection
    assert (out_dir / "pages" / "page-00.json").exists()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_pipeline.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pdf2fxl.pipeline'`

- [ ] **Step 3: Write minimal implementation**

```python
# src/pdf2fxl/pipeline.py
from __future__ import annotations
from pathlib import Path
from typing import Callable, List, Optional, Tuple
import cv2

from .config import Config
from .models import Page
from .ingest import rasterize_page, trim_page, content_bbox, page_count
from .ocr import parse_ocr_response, run_ocr
from .textmask import annotate_style, build_page_mask
from .inpaint import apply_inpainting, Inpainter, LamaInpainter
from .render_epub import write_epub
from .render_pptx import write_pptx

OcrFn = Callable[..., dict]


def _trim(img, cfg: Config):
    if cfg.trim_strategy == "none":
        return img
    return trim_page(img, trim=None)   # content-based (trimbox handled in ingest later)


def convert_page(pdf_path: str, index: int, out_dir: Path, cfg: Config,
                 ocr_fn: OcrFn, inpainter: Inpainter, api_key: str) -> Page:
    pages_dir = out_dir / "pages"; pages_dir.mkdir(parents=True, exist_ok=True)
    raw = rasterize_page(pdf_path, index, cfg.zoom)
    img = _trim(raw, cfg)
    h, w = img.shape[:2]

    resp = ocr_fn(img, cfg, api_key)
    blocks = parse_ocr_response(resp, (w, h), cfg)
    for b in blocks:
        annotate_style(img, b, cfg.dark_thresh)

    mask = build_page_mask(img, blocks, cfg.dark_thresh, cfg.mask_dilate_px)
    clean = apply_inpainting(img, mask, inpainter)

    orig_path = pages_dir / f"page-{index:02d}.png"
    clean_path = pages_dir / f"page-{index:02d}-clean.png"
    cv2.imwrite(str(orig_path), img)
    cv2.imwrite(str(clean_path), clean)

    page = Page(index=index, page_size_px=(w, h), background=str(clean_path),
                original=str(orig_path), blocks=blocks)
    (pages_dir / f"page-{index:02d}.json").write_text(page.to_json(), encoding="utf-8")
    return page


def convert_book(pdf_path: str, out_dir: Path, cfg: Optional[Config] = None,
                 ocr_fn: Optional[OcrFn] = None, inpainter: Optional[Inpainter] = None,
                 api_key: str = "", title: str = "Untitled", language: str = "en",
                 font_path: str = "assets/fonts/NotoSerif-Regular.ttf"
                 ) -> Tuple[Path, Path]:
    cfg = cfg or Config()
    ocr_fn = ocr_fn or run_ocr
    inpainter = inpainter or LamaInpainter()
    out_dir = Path(out_dir); out_dir.mkdir(parents=True, exist_ok=True)

    pages: List[Page] = [
        convert_page(pdf_path, i, out_dir, cfg, ocr_fn, inpainter, api_key)
        for i in range(page_count(pdf_path))
    ]

    epub = out_dir / f"{title}.epub"
    pptx = out_dir / f"{title}.pptx"
    write_epub(pages, epub, title=title, language=language, font_path=font_path)
    write_pptx(pages, pptx, aspect=cfg.pptx_aspect, font_name=cfg.font_map["Latn"])
    return epub, pptx
```

> **Note on the test's OCR fixture dims:** `parse_ocr_response` scales OCR `dimensions`
> to the trimmed page size, so the fake response's box lands proportionally regardless of
> the exact render size. The test asserts artifacts exist, not pixel positions.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_pipeline.py -v`
Expected: PASS (1 passed)

- [ ] **Step 5: Commit**

```bash
git add src/pdf2fxl/pipeline.py tests/test_pipeline.py
git commit -m "feat: orchestrate stages 0-4 in convert_book"
```

---

## Task 12: CLI

**Files:**
- Create: `src/pdf2fxl/cli.py`
- Test: `tests/test_cli.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_cli.py
from click.testing import CliRunner
from unittest.mock import patch
from pathlib import Path
from pdf2fxl.cli import main

def test_cli_invokes_convert_book(tmp_path):
    pdf = tmp_path / "book.pdf"; pdf.write_bytes(b"%PDF-1.4\n")
    with patch("pdf2fxl.cli.convert_book") as m:
        m.return_value = (tmp_path / "book.epub", tmp_path / "book.pptx")
        r = CliRunner().invoke(main, [str(pdf), "-o", str(tmp_path / "out"),
                                      "--title", "Book"],
                               env={"MISTRAL_API_KEY": "test-key"})
    assert r.exit_code == 0, r.output
    assert m.call_count == 1
    kwargs = m.call_args.kwargs
    assert kwargs["api_key"] == "test-key"
    assert kwargs["title"] == "Book"

def test_cli_errors_without_api_key(tmp_path):
    pdf = tmp_path / "book.pdf"; pdf.write_bytes(b"%PDF-1.4\n")
    r = CliRunner().invoke(main, [str(pdf)], env={"MISTRAL_API_KEY": ""})
    assert r.exit_code != 0
    assert "MISTRAL_API_KEY" in r.output
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_cli.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pdf2fxl.cli'`

- [ ] **Step 3: Write minimal implementation**

```python
# src/pdf2fxl/cli.py
from __future__ import annotations
import os
from pathlib import Path
import click

from .config import Config
from .pipeline import convert_book


@click.command()
@click.argument("pdf", type=click.Path(exists=True, dir_okay=False))
@click.option("-o", "--out", "out_dir", default="out", show_default=True,
              type=click.Path(file_okay=False), help="Output directory.")
@click.option("--title", default=None, help="Book title (defaults to the PDF stem).")
@click.option("--language", default="en", show_default=True)
@click.option("--font", "font_path", default="assets/fonts/NotoSerif-Regular.ttf",
              show_default=True, type=click.Path())
def main(pdf: str, out_dir: str, title: str, language: str, font_path: str) -> None:
    """Convert a picture-book PDF into a fixed-layout EPUB and a PPTX."""
    api_key = os.environ.get("MISTRAL_API_KEY", "")
    if not api_key:
        raise click.ClickException("MISTRAL_API_KEY is not set in the environment.")
    title = title or Path(pdf).stem
    epub, pptx = convert_book(pdf, Path(out_dir), cfg=Config(), api_key=api_key,
                              title=title, language=language, font_path=font_path)
    click.echo(f"Wrote {epub}")
    click.echo(f"Wrote {pptx}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_cli.py -v`
Expected: PASS (2 passed)

- [ ] **Step 5: Run the whole fast suite**

Run: `pytest -q -m 'not slow'`
Expected: PASS (all fast tests green).

- [ ] **Step 6: Commit**

```bash
git add src/pdf2fxl/cli.py tests/test_cli.py
git commit -m "feat: add pdf2fxl CLI entry point"
```

---

## Task 13: End-to-end run on the real books + README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write `README.md`**

```markdown
# pdf2fxl

Convert image-only picture-book PDFs into a fixed-layout EPUB3 and a PPTX, replacing
baked-in printed text with real, editable text via Mistral OCR 4 + LaMa inpainting.

## Install
```
python -m venv .venv && . .venv/bin/activate
pip install -e '.[dev]'
```

## Use
```
export MISTRAL_API_KEY=sk-...
pdf2fxl /path/to/Book.pdf -o out/ --title "Book"
# -> out/Book.epub, out/Book.pptx, out/pages/*.json (+ page images)
```

## Pipeline
0. Ingest & trim (PyMuPDF) · 1. OCR+layout (Mistral OCR 4) · 1.5 text mask + style ·
2. Inpaint (LaMa) · 3. Fonts · 4. Render EPUB + PPTX. Per-page JSON is the shared contract.

## Tests
`pytest -q -m 'not slow'` (fast) · `pytest -m slow` (real LaMa + epubcheck).
```

- [ ] **Step 2: Run the real end-to-end conversion (manual verification)**

Run:
```bash
export MISTRAL_API_KEY=...     # real key required
pdf2fxl "/Users/siraj/Downloads/Little_Elephant.pdf" -o out/elephant --title "Little Elephant"
pdf2fxl "/Users/siraj/Downloads/Grandma.pdf" -o out/grandma --title "A Lesson From Grandma"
```
Expected: each command prints two `Wrote ...` lines and exits 0.

- [ ] **Step 3: Verify outputs**

- Open `out/elephant/Little Elephant.epub` in Apple Books / Thorium → pages render, text is selectable, art is clean where text used to be.
- Open `out/elephant/Little Elephant.pptx` in PowerPoint/Keynote → each slide has the clean art plus editable text boxes.
- Spot-check `out/elephant/pages/page-01.json` → block text matches the page, bboxes look sane.
- Repeat for `grandma`. Note any inpaint smudges on busy watercolor pages (accepted per spec).

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: add README and record end-to-end run"
```

---

## Self-Review

**1. Spec coverage** (each spec section → task):
- Ingest & trim → Task 4. OCR + typed/filtered blocks (drop footer) → Task 5. Local mask +
  style (font_px/color/align) → Task 6. LaMa mask-based inpaint → Task 7. Font-per-script map →
  Task 8. Fixed-layout EPUB3 (viewport, %-positioned text, embedded font, pre-paginated) →
  Task 9. PPTX (slide aspect, bg picture, editable text boxes) → Task 10. Intermediate JSON
  contract → Task 2 + written in Task 11. Fully-automated, no human loop → Task 11/12 (no
  review step exists). CLI deliverable → Task 12. All covered.
- Deferred by design (spec non-goals / future): Indic fonts, generative-inpaint fallback,
  PPTX font embedding, translation, TrimBox-based trim (content-trim is the tested default;
  `trim_strategy="trimbox"` is a config hook to implement when validated on real files).

**2. Placeholder scan:** No "TBD/TODO/handle edge cases" steps; every code step shows complete
code; every run step states the exact command and expected result.

**3. Type consistency:** `Block`/`Page` field names identical across models, ocr, textmask,
renderers, pipeline. `bbox` is `(x,y,w,h)` everywhere. `Inpainter.__call__(PIL, PIL)->PIL` used
consistently by `FakeInpainter`, `LamaInpainter`, and `apply_inpainting`. `convert_book`
signature matches the CLI call and the pipeline test. `parse_ocr_response(resp, page_size_px,
cfg)` signature matches its test and pipeline call.

**Known implementation risk to confirm during Task 5/13:** exact Mistral OCR-4 SDK kwarg names
(`include_blocks`, `extract_footer`) and response field names (`blocks[].top_left_x`,
`dimensions`). The parser is isolated and fixture-tested, so confirming these touches only
`run_ocr` + the fixture, not the rest of the pipeline.
