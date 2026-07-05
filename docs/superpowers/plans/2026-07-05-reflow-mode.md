# Reflow Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `--mode reflow` path to `pdf2fxl` that turns a scanned text-book PDF into a reflowable EPUB3 (plus Markdown and DOCX) with a book-global heading hierarchy computed mathematically from Mistral OCR block geometry.

**Architecture:** Reuse ingest + Mistral OCR + font embedding. A new `src/pdf2fxl/reflow/` package measures each block's true type size from the scan's ink-row projection, derives the body size from whole-book text mass, clusters heading sizes into levels (reconciled with section-numbering depth), normalizes layout (spread-splitting, header/footer stripping, drop-cap merge, paragraph re-join), and emits an ordered **Doc model** that three renderers (Markdown, DOCX, reflowable EPUB) consume. Mistral's heading-vs-not classification is trusted; only the *level* is computed. The fixed-layout path is untouched.

**Tech Stack:** Python 3.11+, numpy, opencv-python-headless, Pillow, python-docx (new), lxml, click, pytest. Manual EPUB zip packaging (mirrors existing `render_epub.py`).

---

## Design reference

Spec: [docs/superpowers/specs/2026-07-05-reflow-mode-design.md](../specs/2026-07-05-reflow-mode-design.md)

## File structure (what each new file owns)

- `src/pdf2fxl/reflow/__init__.py` — package marker.
- `src/pdf2fxl/reflow/segment.py` — `Segment`, the mutable unit threaded through the reflow pipeline; heading-type constants.
- `src/pdf2fxl/reflow/typesize.py` — measure `size_px` + `n_lines` + weight/centering from the page image (ink-row projection).
- `src/pdf2fxl/reflow/hierarchy.py` — pure functions: `body_size`, `parse_numbering`, `assign_levels`.
- `src/pdf2fxl/reflow/layout.py` — `detect_columns`, `strip_running`, `order_segments`, `merge_dropcaps`, `rejoin_paragraphs`.
- `src/pdf2fxl/reflow/crop.py` — `crop_region`, `width_frac`, `classify_image`.
- `src/pdf2fxl/reflow/docmodel.py` — output nodes (`Heading`, `Paragraph`, `Run`, `Figure`, `Table`, `Formula`, `ChapterBreak`) + `Doc` (JSON round-trip).
- `src/pdf2fxl/reflow/ocr_reflow.py` — `parse_ocr_reflow`: keep heading/text/list/caption/table/image blocks, preserve line breaks.
- `src/pdf2fxl/reflow/assemble.py` — `build_doc`: orchestrate pages → `Doc`.
- `src/pdf2fxl/reflow/render_md.py` — `render_markdown(doc) -> str`.
- `src/pdf2fxl/reflow/render_docx.py` — `render_docx(doc, path)`.
- `src/pdf2fxl/reflow/render_epub_reflow.py` — `write_epub_reflow(doc, path, font_path)`.
- Modify `src/pdf2fxl/config.py`, `src/pdf2fxl/pipeline.py`, `src/pdf2fxl/cli.py`, `pyproject.toml`.

Every task: TDD (test first, watch it fail, minimal implement, watch it pass, commit). Run tests with `pytest -q`.

---

## Task 0: Add python-docx dependency

**Files:**
- Modify: `pyproject.toml:14-23`

- [ ] **Step 1: Add the dependency**

In `pyproject.toml`, add `"python-docx>=1.1"` to the `dependencies` list:

```toml
dependencies = [
  "pymupdf>=1.24",
  "mistralai>=1.5",
  "opencv-python-headless>=4.9",
  "numpy>=1.26",
  "pillow>=10.0",
  "python-pptx>=1.0",
  "python-docx>=1.1",
  "lxml>=5.0",
  "click>=8.1",
]
```

- [ ] **Step 2: Install it**

Run: `pip install -e '.[dev]'`
Expected: installs `python-docx` and reports success.

- [ ] **Step 3: Verify import**

Run: `python -c "import docx; print(docx.__version__)"`
Expected: prints a version like `1.1.2`.

- [ ] **Step 4: Commit**

```bash
git add pyproject.toml
git commit -m "build: add python-docx for reflow DOCX renderer"
```

---

## Task 1: Reflow package + Segment type

**Files:**
- Create: `src/pdf2fxl/reflow/__init__.py`
- Create: `src/pdf2fxl/reflow/segment.py`
- Test: `tests/reflow/test_segment.py`

- [ ] **Step 1: Write the failing test**

Create `tests/reflow/__init__.py` (empty) and `tests/reflow/test_segment.py`:

```python
from pdf2fxl.reflow.segment import Segment, is_heading_type, HEADING_TYPES


def test_segment_defaults():
    s = Segment(page_index=0, type="text", bbox=(1.0, 2.0, 30.0, 40.0), text="hello")
    assert s.size_px == 0.0
    assert s.n_lines == 1
    assert s.level == 0
    assert s.column == 0
    assert s.bold is False


def test_heading_type_detection():
    assert is_heading_type("title") is True
    assert is_heading_type("section_header") is True
    assert is_heading_type("text") is False
    assert "title" in HEADING_TYPES
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/reflow/test_segment.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'pdf2fxl.reflow'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/pdf2fxl/reflow/__init__.py` (empty). Create `src/pdf2fxl/reflow/segment.py`:

```python
from __future__ import annotations
from dataclasses import dataclass
from typing import Tuple

# Mistral OCR block types treated as headings (level computed by us, not Mistral).
HEADING_TYPES = frozenset({"title", "section_header", "heading"})


def is_heading_type(block_type: str) -> bool:
    return block_type in HEADING_TYPES


@dataclass
class Segment:
    """One OCR block threaded through the reflow pipeline. Fields are filled in
    stages: OCR sets type/bbox/text; typesize sets size_px/n_lines/bold/centered;
    layout sets column/order and drops running heads; hierarchy sets level."""
    page_index: int
    type: str                                  # raw Mistral block type
    bbox: Tuple[float, float, float, float]    # x, y, w, h px on the page
    text: str
    size_px: float = 0.0
    n_lines: int = 1
    bold: bool = False
    centered: bool = False
    column: int = 0                            # 0-based reading column
    order: int = 0                             # global reading order
    level: int = 0                             # heading level 1..6; 0 = not a heading
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/reflow/test_segment.py -q`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add src/pdf2fxl/reflow/__init__.py src/pdf2fxl/reflow/segment.py tests/reflow/__init__.py tests/reflow/test_segment.py
git commit -m "feat(reflow): Segment type and heading-type constants"
```

---

## Task 2: OCR parse for reflow (keep images/tables/headings, preserve line breaks)

**Files:**
- Create: `src/pdf2fxl/reflow/ocr_reflow.py`
- Test: `tests/reflow/test_ocr_reflow.py`

The reflow parser differs from `ocr.parse_ocr_response`: it keeps `image`/`table`/heading blocks (the fixed-layout parser drops them), and it preserves newlines in `content` (line count feeds size estimation).

- [ ] **Step 1: Write the failing test**

Create `tests/reflow/test_ocr_reflow.py`:

```python
from pdf2fxl.reflow.ocr_reflow import parse_ocr_reflow

RESP = {
    "pages": [{
        "dimensions": {"width": 100, "height": 200},
        "blocks": [
            {"type": "title", "top_left_x": 10, "top_left_y": 5,
             "bottom_right_x": 90, "bottom_right_y": 20, "content": "# Chapter One"},
            {"type": "text", "top_left_x": 10, "top_left_y": 25,
             "bottom_right_x": 90, "bottom_right_y": 60,
             "content": "line one\nline two"},
            {"type": "image", "top_left_x": 10, "top_left_y": 65,
             "bottom_right_x": 90, "bottom_right_y": 120, "content": ""},
            {"type": "page_number", "top_left_x": 45, "top_left_y": 190,
             "bottom_right_x": 55, "bottom_right_y": 198, "content": "12"},
        ],
    }]
}


def test_keeps_images_and_headings_and_line_breaks():
    segs = parse_ocr_reflow(RESP, (100, 200))
    types = [s.type for s in segs]
    assert "image" in types                    # images kept (dropped in fxl path)
    assert "title" in types
    # heading markdown marker stripped, text preserved
    title = next(s for s in segs if s.type == "title")
    assert title.text == "Chapter One"
    # newlines preserved so line count is recoverable
    body = next(s for s in segs if s.type == "text")
    assert body.text == "line one\nline two"


def test_scales_bbox_to_page_pixels():
    segs = parse_ocr_reflow(RESP, (200, 400))   # 2x
    title = next(s for s in segs if s.type == "title")
    x, y, w, h = title.bbox
    assert abs(x - 20) < 1e-6 and abs(w - 160) < 1e-6
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/reflow/test_ocr_reflow.py -q`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Write minimal implementation**

Create `src/pdf2fxl/reflow/ocr_reflow.py`:

```python
from __future__ import annotations
from typing import List, Tuple
import re

from .segment import Segment

# Kept for reflow. page_number/header/footer are kept here too and removed later
# by layout.strip_running (position + cross-page repetition), not blanket-dropped.
_KEEP = frozenset({"text", "title", "section_header", "heading", "list",
                   "caption", "table", "image", "page_number", "header", "footer"})


def _clean_reflow(s: str) -> str:
    s = (s or "").strip()
    s = re.sub(r"^#{1,6}\s*", "", s)     # leading markdown heading marker
    s = re.sub(r"^[-*>]\s+", "", s)      # leading list/quote marker
    # collapse spaces/tabs but PRESERVE newlines (line count feeds size math)
    s = re.sub(r"[ \t]{2,}", " ", s)
    s = re.sub(r"[ \t]*\n[ \t]*", "\n", s)
    return s.strip()


def parse_ocr_reflow(resp: dict, page_size_px: Tuple[int, int]) -> List[Segment]:
    page = resp["pages"][0]
    dims = page["dimensions"]
    sx = page_size_px[0] / dims["width"]
    sy = page_size_px[1] / dims["height"]
    segs: List[Segment] = []
    for b in page.get("blocks", []):
        t = b.get("type", "text")
        if t not in _KEEP:
            continue
        x0 = b["top_left_x"] * sx; y0 = b["top_left_y"] * sy
        x1 = b["bottom_right_x"] * sx; y1 = b["bottom_right_y"] * sy
        text = _clean_reflow(b.get("content", ""))
        if t not in ("image", "table") and not text:
            continue
        segs.append(Segment(page_index=0, type=t,
                            bbox=(x0, y0, x1 - x0, y1 - y0), text=text))
    return segs
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/reflow/test_ocr_reflow.py -q`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add src/pdf2fxl/reflow/ocr_reflow.py tests/reflow/test_ocr_reflow.py
git commit -m "feat(reflow): OCR parse that keeps images/tables/headings and line breaks"
```

---

## Task 3: Measure type size from ink-row projection

**Files:**
- Create: `src/pdf2fxl/reflow/typesize.py`
- Test: `tests/reflow/test_typesize.py`

`size_px` = median ink-band thickness (proportional to font size, comparable book-wide). `n_lines` = number of ink bands.

- [ ] **Step 1: Write the failing test**

Create `tests/reflow/test_typesize.py`:

```python
import numpy as np
from pdf2fxl.reflow.typesize import measure_segment
from pdf2fxl.reflow.segment import Segment


def _striped(page_h=200, page_w=100, band_h=8, pitch=16, n=5, top=20):
    """White page with n dark horizontal bands of thickness band_h at given pitch."""
    img = np.full((page_h, page_w), 255, np.uint8)
    for i in range(n):
        y = top + i * pitch
        img[y:y + band_h, 10:90] = 0
    return img


def test_measures_line_count_and_size():
    img = _striped()
    seg = Segment(page_index=0, type="text", bbox=(0, 0, 100, 200), text="x")
    measure_segment(img, seg)
    assert seg.n_lines == 5
    # band thickness ~ 8 px
    assert 6 <= seg.size_px <= 10


def test_single_line_uses_band_thickness():
    img = _striped(n=1)
    seg = Segment(page_index=0, type="title", bbox=(0, 0, 100, 200), text="Title")
    measure_segment(img, seg)
    assert seg.n_lines == 1
    assert 6 <= seg.size_px <= 10


def test_blank_region_is_safe():
    img = np.full((50, 50), 255, np.uint8)
    seg = Segment(page_index=0, type="text", bbox=(0, 0, 50, 50), text="")
    measure_segment(img, seg)
    assert seg.size_px == 0.0
    assert seg.n_lines == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/reflow/test_typesize.py -q`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Write minimal implementation**

Create `src/pdf2fxl/reflow/typesize.py`:

```python
from __future__ import annotations
from typing import List, Tuple
import numpy as np

from .segment import Segment


def _runs(mask: np.ndarray) -> List[Tuple[int, int]]:
    """Return (start, end_exclusive) index pairs of True runs in a 1-D bool array."""
    runs: List[Tuple[int, int]] = []
    start = None
    for i, v in enumerate(mask):
        if v and start is None:
            start = i
        elif not v and start is not None:
            runs.append((start, i)); start = None
    if start is not None:
        runs.append((start, len(mask)))
    return runs


def measure_segment(gray: np.ndarray, seg: Segment, dark_thresh: int = 128) -> None:
    """Set seg.size_px (median ink-band thickness) and seg.n_lines from the
    horizontal ink-row projection of the block crop. Mutates seg in place."""
    x, y, w, h = (int(round(v)) for v in seg.bbox)
    x = max(0, x); y = max(0, y)
    crop = gray[y:y + h, x:x + w]
    if crop.size == 0 or crop.shape[1] == 0:
        return
    ink_per_row = (crop < dark_thresh).sum(axis=1)
    row_has_ink = ink_per_row > max(1.0, 0.02 * crop.shape[1])
    bands = _runs(row_has_ink)
    if not bands:
        return
    thicknesses = [e - s for s, e in bands]
    seg.n_lines = len(bands)
    seg.size_px = float(np.median(thicknesses))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/reflow/test_typesize.py -q`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add src/pdf2fxl/reflow/typesize.py tests/reflow/test_typesize.py
git commit -m "feat(reflow): measure type size and line count from ink-row projection"
```

---

## Task 4: Weight + centering features

**Files:**
- Modify: `src/pdf2fxl/reflow/typesize.py`
- Test: `tests/reflow/test_typesize.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/reflow/test_typesize.py`:

```python
from pdf2fxl.reflow.typesize import detect_weight_centering


def test_centered_block_flagged():
    # ink only in the middle third of the crop width
    img = np.full((40, 300), 255, np.uint8)
    img[10:30, 120:180] = 0
    seg = Segment(page_index=0, type="title", bbox=(0, 0, 300, 40), text="Hi")
    detect_weight_centering(img, seg, page_width=300)
    assert seg.centered is True


def test_left_flush_block_not_centered():
    img = np.full((40, 300), 255, np.uint8)
    img[10:30, 0:60] = 0
    seg = Segment(page_index=0, type="title", bbox=(0, 0, 300, 40), text="Hi")
    detect_weight_centering(img, seg, page_width=300)
    assert seg.centered is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/reflow/test_typesize.py::test_centered_block_flagged -q`
Expected: FAIL — `ImportError: cannot import name 'detect_weight_centering'`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/pdf2fxl/reflow/typesize.py`:

```python
def detect_weight_centering(gray: np.ndarray, seg: Segment, page_width: float,
                            dark_thresh: int = 128) -> None:
    """Set seg.centered from ink column extent vs the page width, and seg.bold
    from ink density within the ink rows. Mutates seg in place."""
    x, y, w, h = (int(round(v)) for v in seg.bbox)
    x = max(0, x); y = max(0, y)
    crop = gray[y:y + h, x:x + w]
    if crop.size == 0:
        return
    dark = crop < dark_thresh
    cols = np.where(dark.any(axis=0))[0]
    if cols.size:
        left = x + cols[0]
        right = x + cols[-1]
        left_margin = left / page_width
        right_margin = (page_width - right) / page_width
        # centered: comparable margins on both sides and not spanning full width
        span = (right - left) / page_width
        seg.centered = span < 0.85 and abs(left_margin - right_margin) < 0.08
    rows = dark.any(axis=1)
    if rows.any():
        seg.bold = float(dark[rows].mean()) > 0.30
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/reflow/test_typesize.py -q`
Expected: PASS (5 passed).

- [ ] **Step 5: Commit**

```bash
git add src/pdf2fxl/reflow/typesize.py tests/reflow/test_typesize.py
git commit -m "feat(reflow): detect centering and bold weight from ink distribution"
```

---

## Task 5: Body size from global text mass

**Files:**
- Create: `src/pdf2fxl/reflow/hierarchy.py`
- Test: `tests/reflow/test_hierarchy.py`

- [ ] **Step 1: Write the failing test**

Create `tests/reflow/test_hierarchy.py`:

```python
from pdf2fxl.reflow.hierarchy import body_size
from pdf2fxl.reflow.segment import Segment


def _seg(type_, size, text):
    return Segment(page_index=0, type=type_, bbox=(0, 0, 10, 10), text=text,
                   size_px=size)


def test_body_size_is_the_char_mass_peak():
    segs = [
        _seg("text", 10.0, "x" * 500),   # lots of body at size 10
        _seg("text", 10.2, "y" * 400),
        _seg("title", 20.0, "Big Heading"),   # heading excluded
        _seg("text", 30.0, "z" * 5),     # tiny amount of large text
    ]
    assert 9.5 <= body_size(segs) <= 10.7


def test_body_size_empty_returns_zero():
    assert body_size([]) == 0.0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/reflow/test_hierarchy.py -q`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Write minimal implementation**

Create `src/pdf2fxl/reflow/hierarchy.py`:

```python
from __future__ import annotations
from collections import defaultdict
from typing import Dict, List
import re

from .segment import Segment, is_heading_type


def body_size(segments: List[Segment], bin_px: float = 0.5) -> float:
    """The type size carrying the most character mass among non-heading text
    blocks — i.e. body text. Returns 0.0 if there is no usable text."""
    mass: Dict[float, float] = defaultdict(float)
    for s in segments:
        if is_heading_type(s.type) or s.type in ("image", "table"):
            continue
        if s.size_px <= 0 or not s.text:
            continue
        key = round(s.size_px / bin_px) * bin_px
        mass[key] += len(s.text)
    if not mass:
        return 0.0
    return max(mass.items(), key=lambda kv: kv[1])[0]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/reflow/test_hierarchy.py -q`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add src/pdf2fxl/reflow/hierarchy.py tests/reflow/test_hierarchy.py
git commit -m "feat(reflow): body size from global character mass"
```

---

## Task 6: Section-numbering parser

**Files:**
- Modify: `src/pdf2fxl/reflow/hierarchy.py`
- Test: `tests/reflow/test_hierarchy.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/reflow/test_hierarchy.py`:

```python
from pdf2fxl.reflow.hierarchy import parse_numbering


def test_dotted_decimal_depth():
    assert parse_numbering("1. Introduction") == 1
    assert parse_numbering("1.2 Historical Perspective") == 2
    assert parse_numbering("1.2.1. Early Discoveries") == 3


def test_roman_and_chapter_are_top_level():
    assert parse_numbering("IV. Methods") == 1
    assert parse_numbering("Chapter 3 The Gut") == 1


def test_devanagari_numeral_prefix():
    assert parse_numbering("२. प्रकरण") == 1


def test_no_numbering_returns_zero():
    assert parse_numbering("Introduction") == 0
    assert parse_numbering("Opportunity: consider this") == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/reflow/test_hierarchy.py::test_dotted_decimal_depth -q`
Expected: FAIL — `ImportError`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/pdf2fxl/reflow/hierarchy.py`:

```python
_DEC = re.compile(r"^\s*(\d+(?:\.\d+)*)\.?\s+\S")
_ROMAN = re.compile(r"^\s*([IVXLCDM]+)\.\s+\S")
_CHAPTER = re.compile(r"^\s*chapter\s+\d+", re.IGNORECASE)
_DEVA_NUM = re.compile(r"^\s*[०-९]+[.।]?\s+\S")


def parse_numbering(text: str) -> int:
    """Heading level implied by a leading section number, or 0 if none.
    Dotted decimals give depth (1 -> 1, 1.2 -> 2, 1.2.1 -> 3); Roman numerals,
    'Chapter N', and Devanagari numerals are treated as top level (1)."""
    if not text:
        return 0
    m = _DEC.match(text)
    if m:
        return m.group(1).count(".") + 1
    if _ROMAN.match(text) or _CHAPTER.match(text) or _DEVA_NUM.match(text):
        return 1
    return 0
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/reflow/test_hierarchy.py -q`
Expected: PASS (all passed).

- [ ] **Step 5: Commit**

```bash
git add src/pdf2fxl/reflow/hierarchy.py tests/reflow/test_hierarchy.py
git commit -m "feat(reflow): section-numbering depth parser (Latin/Roman/Devanagari)"
```

---

## Task 7: Assign heading levels (numbering + size clustering)

**Files:**
- Modify: `src/pdf2fxl/reflow/hierarchy.py`
- Test: `tests/reflow/test_hierarchy.py`

`assign_levels` mutates each heading `Segment.level`. Numbering is authoritative when present; otherwise headings are ranked into tiers by measured size relative to body.

- [ ] **Step 1: Write the failing test**

Append to `tests/reflow/test_hierarchy.py`:

```python
from pdf2fxl.reflow.hierarchy import assign_levels


def _h(size, text):
    return Segment(page_index=0, type="title", bbox=(0, 0, 10, 10), text=text,
                   size_px=size)


def test_numbering_drives_levels_when_present():
    body = [_seg("text", 10.0, "x" * 300)]
    heads = [_h(18, "1. Introduction"), _h(15, "1.2 History"),
             _h(13, "1.2.1 Early")]
    assign_levels(heads + body)
    assert [h.level for h in heads] == [1, 2, 3]


def test_size_tiers_when_no_numbering():
    body = [_seg("text", 10.0, "x" * 300)]
    heads = [_h(24, "Part Title"), _h(16, "Section"), _h(16, "Another Section"),
             _h(12, "Small Sub")]
    assign_levels(heads + body)
    # largest size -> H1, next distinct tier -> H2, next -> H3
    assert heads[0].level == 1
    assert heads[1].level == 2 and heads[2].level == 2
    assert heads[3].level == 3


def test_non_headings_stay_level_zero():
    body = [_seg("text", 10.0, "x" * 300)]
    assign_levels(body)
    assert body[0].level == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/reflow/test_hierarchy.py::test_numbering_drives_levels_when_present -q`
Expected: FAIL — `ImportError`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/pdf2fxl/reflow/hierarchy.py`:

```python
def _tier_levels(sizes: List[float], rel_gap: float = 0.06) -> Dict[float, int]:
    """Map each distinct size to a 1-based rank tier. Sizes within rel_gap of the
    current tier's reference collapse into the same tier (largest = tier 1)."""
    uniq = sorted(set(sizes), reverse=True)
    levels: Dict[float, int] = {}
    tier = 1
    ref = uniq[0] if uniq else 0.0
    for sz in uniq:
        if ref > 0 and (ref - sz) / ref > rel_gap:
            tier += 1
            ref = sz
        levels[sz] = tier
    return levels


def assign_levels(segments: List[Segment], max_level: int = 6) -> None:
    """Set .level (1..max_level) on every heading Segment, book-globally.
    Numbering depth is authoritative where present; remaining headings are tiered
    by measured size. Non-headings keep level 0."""
    heads = [s for s in segments if is_heading_type(s.type)]
    if not heads:
        return
    numbered = [(s, parse_numbering(s.text)) for s in heads]
    if any(depth > 0 for _, depth in numbered):
        # Learn the typical size for each numbering depth, then classify the
        # unnumbered headings by nearest depth-size.
        by_depth: Dict[int, List[float]] = defaultdict(list)
        for s, depth in numbered:
            if depth > 0 and s.size_px > 0:
                by_depth[depth].append(s.size_px)
        avg = {d: sum(v) / len(v) for d, v in by_depth.items() if v}
        for s, depth in numbered:
            if depth > 0:
                s.level = min(depth, max_level)
            elif avg:
                nearest = min(avg, key=lambda d: abs(avg[d] - s.size_px))
                s.level = min(nearest, max_level)
            else:
                s.level = 1
        return
    # No numbering anywhere: pure size tiers.
    levels = _tier_levels([s.size_px for s in heads])
    for s in heads:
        s.level = min(levels.get(s.size_px, 1), max_level)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/reflow/test_hierarchy.py -q`
Expected: PASS (all passed).

- [ ] **Step 5: Commit**

```bash
git add src/pdf2fxl/reflow/hierarchy.py tests/reflow/test_hierarchy.py
git commit -m "feat(reflow): assign heading levels from numbering + size tiers"
```

---

## Task 8: Column / two-up spread detection

**Files:**
- Create: `src/pdf2fxl/reflow/layout.py`
- Test: `tests/reflow/test_layout.py`

- [ ] **Step 1: Write the failing test**

Create `tests/reflow/test_layout.py`:

```python
from pdf2fxl.reflow.layout import detect_columns
from pdf2fxl.reflow.segment import Segment


def _seg(x, w=200, y=0, h=20, text="t"):
    return Segment(page_index=0, type="text", bbox=(x, y, w, h), text=text)


def test_two_up_split_assigns_columns():
    page_w = 1000
    left = [_seg(50, y=i * 30) for i in range(5)]     # x-center ~150
    right = [_seg(600, y=i * 30) for i in range(5)]   # x-center ~700
    segs = left + right
    detect_columns(segs, page_width=page_w, mode="auto")
    assert all(s.column == 0 for s in left)
    assert all(s.column == 1 for s in right)


def test_single_column_all_zero():
    page_w = 1000
    segs = [_seg(100, w=800, y=i * 30) for i in range(6)]
    detect_columns(segs, page_width=page_w, mode="auto")
    assert all(s.column == 0 for s in segs)


def test_forced_single_mode_never_splits():
    page_w = 1000
    segs = [_seg(50), _seg(600)]
    detect_columns(segs, page_width=page_w, mode="single")
    assert all(s.column == 0 for s in segs)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/reflow/test_layout.py -q`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Write minimal implementation**

Create `src/pdf2fxl/reflow/layout.py`:

```python
from __future__ import annotations
from typing import List
import numpy as np

from .segment import Segment


def detect_columns(segments: List[Segment], page_width: float,
                   mode: str = "auto") -> None:
    """Set seg.column (0=left, 1=right) for two-up spreads / two-column pages.
    mode: 'single' forces one column, 'two-up' forces a split at mid-page,
    'auto' splits only when x-centers form two groups with a clear central gutter."""
    if mode == "single" or len(segments) < 2:
        for s in segments:
            s.column = 0
        return
    mid = page_width / 2.0
    if mode == "two-up":
        for s in segments:
            s.column = 0 if (s.bbox[0] + s.bbox[2] / 2) < mid else 1
        return
    centers = sorted((s.bbox[0] + s.bbox[2] / 2) for s in segments)
    # largest gap between consecutive centers within the central band
    best_gap, split = 0.0, None
    for a, b in zip(centers, centers[1:]):
        if 0.3 * page_width < a < 0.7 * page_width or 0.3 * page_width < b < 0.7 * page_width:
            if b - a > best_gap:
                best_gap, split = b - a, (a + b) / 2
    if split is not None and best_gap > 0.12 * page_width:
        for s in segments:
            s.column = 0 if (s.bbox[0] + s.bbox[2] / 2) < split else 1
    else:
        for s in segments:
            s.column = 0
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/reflow/test_layout.py -q`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add src/pdf2fxl/reflow/layout.py tests/reflow/test_layout.py
git commit -m "feat(reflow): column / two-up spread detection"
```

---

## Task 9: Strip running headers/footers

**Files:**
- Modify: `src/pdf2fxl/reflow/layout.py`
- Test: `tests/reflow/test_layout.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/reflow/test_layout.py`:

```python
from pdf2fxl.reflow.layout import strip_running


def _mk(page_index, text, y, h_page=1000):
    return Segment(page_index=page_index, type="text", bbox=(50, y, 200, 20),
                   text=text)


def test_removes_page_numbers_and_repeated_running_heads():
    pages = []
    for p in range(4):
        pages.append([
            _mk(p, str(12 + p), y=970),               # page number in bottom band
            _mk(p, "The Book Title", y=975),          # repeated running head
            _mk(p, f"Unique body text {p}", y=500),   # real content
        ])
    kept = strip_running(pages, page_height=1000)
    flat = [s.text for page in kept for s in page]
    assert all(not t.isdigit() for t in flat)
    assert "The Book Title" not in flat
    assert any(t.startswith("Unique body text") for t in flat)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/reflow/test_layout.py::test_removes_page_numbers_and_repeated_running_heads -q`
Expected: FAIL — `ImportError`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/pdf2fxl/reflow/layout.py`:

```python
import re as _re
from collections import Counter

_PAGENO = _re.compile(r"^[\divxlcdmIVXLCDM०-९]+$")


def _norm(t: str) -> str:
    return _re.sub(r"\s+", " ", t.strip().lower())


def strip_running(pages: List[List[Segment]], page_height: float,
                  band: float = 0.08, repeat_min: int = 3) -> List[List[Segment]]:
    """Drop running heads/footers/page numbers. A margin-band block is removed if
    its text is a bare page number, or its normalized text repeats in the same
    band on >= repeat_min pages."""
    top = band * page_height
    bot = (1 - band) * page_height
    margin_texts: Counter = Counter()
    for page in pages:
        for s in page:
            cy = s.bbox[1] + s.bbox[3] / 2
            if cy < top or cy > bot:
                margin_texts[_norm(s.text)] += 1
    out: List[List[Segment]] = []
    for page in pages:
        keep = []
        for s in page:
            cy = s.bbox[1] + s.bbox[3] / 2
            in_margin = cy < top or cy > bot
            if in_margin and s.text and _PAGENO.match(s.text.strip()):
                continue
            if in_margin and margin_texts[_norm(s.text)] >= repeat_min:
                continue
            keep.append(s)
        out.append(keep)
    return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/reflow/test_layout.py -q`
Expected: PASS (all passed).

- [ ] **Step 5: Commit**

```bash
git add src/pdf2fxl/reflow/layout.py tests/reflow/test_layout.py
git commit -m "feat(reflow): strip running headers/footers and page numbers"
```

---

## Task 10: Reading order, drop-cap merge, paragraph re-join

**Files:**
- Modify: `src/pdf2fxl/reflow/layout.py`
- Test: `tests/reflow/test_layout.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/reflow/test_layout.py`:

```python
from pdf2fxl.reflow.layout import order_segments, merge_dropcaps, rejoin_paragraphs


def test_order_left_column_before_right_then_top_down():
    r1 = Segment(0, "text", (600, 10, 200, 20), "right-top"); r1.column = 1
    l1 = Segment(0, "text", (50, 40, 200, 20), "left-lower"); l1.column = 0
    l0 = Segment(0, "text", (50, 10, 200, 20), "left-top"); l0.column = 0
    ordered = order_segments([r1, l1, l0])
    assert [s.text for s in ordered] == ["left-top", "left-lower", "right-top"]


def test_dropcap_merges_into_next_paragraph():
    cap = Segment(0, "text", (50, 100, 40, 40), "S", size_px=40)
    para = Segment(0, "text", (95, 100, 300, 120), "chool begins here.", size_px=10)
    out = merge_dropcaps([cap, para], body_px=10.0)
    assert len(out) == 1
    assert out[0].text.startswith("School begins here")


def test_rejoin_paragraph_split_across_pages():
    a = Segment(0, "text", (0, 0, 10, 10), "the sentence continues")
    b = Segment(1, "text", (0, 0, 10, 10), "onto the next page.")
    out = rejoin_paragraphs([a, b])
    assert len(out) == 1
    assert out[0].text == "the sentence continues onto the next page."


def test_rejoin_keeps_separate_when_sentence_ends():
    a = Segment(0, "text", (0, 0, 10, 10), "A finished sentence.")
    b = Segment(1, "text", (0, 0, 10, 10), "Another one starts.")
    out = rejoin_paragraphs([a, b])
    assert len(out) == 2
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/reflow/test_layout.py::test_order_left_column_before_right_then_top_down -q`
Expected: FAIL — `ImportError`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/pdf2fxl/reflow/layout.py`:

```python
from .segment import is_heading_type

_SENT_END = tuple(".!?।॥\"')]")   # incl. Devanagari danda/double danda


def order_segments(segments: List[Segment]) -> List[Segment]:
    """Sort by (page, column, y, x) and assign global .order."""
    ordered = sorted(segments, key=lambda s: (s.page_index, s.column,
                                              round(s.bbox[1]), s.bbox[0]))
    for i, s in enumerate(ordered):
        s.order = i
    return ordered


def merge_dropcaps(segments: List[Segment], body_px: float,
                   ratio: float = 1.8) -> List[Segment]:
    """Fold an oversized 1-2 glyph block into the following body paragraph as its
    first letter. Assumes `segments` are already in reading order."""
    out: List[Segment] = []
    i = 0
    while i < len(segments):
        s = segments[i]
        is_cap = (len(s.text.strip()) <= 2 and body_px > 0
                  and s.size_px >= ratio * body_px and not is_heading_type(s.type))
        if is_cap and i + 1 < len(segments) and not is_heading_type(segments[i + 1].type):
            nxt = segments[i + 1]
            nxt.text = (s.text.strip() + nxt.text).strip()
            out.append(nxt)
            i += 2
        else:
            out.append(s)
            i += 1
    return out


def rejoin_paragraphs(segments: List[Segment]) -> List[Segment]:
    """Merge consecutive body paragraphs split across a page/column break: join
    when the previous text does not end sentence-final. De-hyphenates trailing '-'.
    Assumes reading order."""
    out: List[Segment] = []
    for s in segments:
        if (out and not is_heading_type(s.type) and not is_heading_type(out[-1].type)
                and out[-1].type == "text" and s.type == "text"):
            prev = out[-1].text.rstrip()
            if prev.endswith("-"):
                out[-1].text = prev[:-1] + s.text.lstrip()
                continue
            if prev and not prev.endswith(_SENT_END):
                out[-1].text = prev + " " + s.text.lstrip()
                continue
        out.append(s)
    return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/reflow/test_layout.py -q`
Expected: PASS (all passed).

- [ ] **Step 5: Commit**

```bash
git add src/pdf2fxl/reflow/layout.py tests/reflow/test_layout.py
git commit -m "feat(reflow): reading order, drop-cap merge, cross-break paragraph rejoin"
```

---

## Task 11: Figure/table crop + proportional width + classification

**Files:**
- Create: `src/pdf2fxl/reflow/crop.py`
- Test: `tests/reflow/test_crop.py`

- [ ] **Step 1: Write the failing test**

Create `tests/reflow/test_crop.py`:

```python
import numpy as np
from pathlib import Path
from PIL import Image
from pdf2fxl.reflow.crop import crop_region, width_frac, classify_image


def test_crop_writes_png(tmp_path):
    img = np.zeros((100, 100, 3), np.uint8)
    img[20:60, 10:70] = 255
    out = crop_region(img, (10, 20, 60, 40), tmp_path / "fig-0.png", pad=0)
    assert out.exists()
    w, h = Image.open(out).size
    assert (w, h) == (60, 40)


def test_width_frac_is_bbox_over_column():
    assert abs(width_frac(300, column_width=600) - 0.5) < 1e-6
    assert width_frac(900, column_width=600) == 1.0   # clamped


def test_classify_by_area_fraction():
    assert classify_image(area_frac=0.6) == "plate"
    assert classify_image(area_frac=0.2) == "figure"
    assert classify_image(area_frac=0.01) == "inline"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/reflow/test_crop.py -q`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Write minimal implementation**

Create `src/pdf2fxl/reflow/crop.py`:

```python
from __future__ import annotations
from pathlib import Path
from typing import Tuple
import cv2


def crop_region(image_bgr, bbox: Tuple[float, float, float, float],
                out_path: Path, pad: int = 4) -> Path:
    """Crop bbox (+pad) from the page image and write a PNG. Returns out_path."""
    h, w = image_bgr.shape[:2]
    x, y, bw, bh = (int(round(v)) for v in bbox)
    x0 = max(0, x - pad); y0 = max(0, y - pad)
    x1 = min(w, x + bw + pad); y1 = min(h, y + bh + pad)
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out_path), image_bgr[y0:y1, x0:x1])
    return out_path


def width_frac(bbox_w: float, column_width: float) -> float:
    """Image display width as a fraction of the text column (clamped to 1.0)."""
    if column_width <= 0:
        return 1.0
    return min(1.0, bbox_w / column_width)


def classify_image(area_frac: float) -> str:
    """plate (>=0.45 of page), figure (>=0.03), else inline."""
    if area_frac >= 0.45:
        return "plate"
    if area_frac >= 0.03:
        return "figure"
    return "inline"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/reflow/test_crop.py -q`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add src/pdf2fxl/reflow/crop.py tests/reflow/test_crop.py
git commit -m "feat(reflow): figure/table crop, proportional width, classification"
```

---

## Task 12: Document model (nodes + Doc JSON)

**Files:**
- Create: `src/pdf2fxl/reflow/docmodel.py`
- Test: `tests/reflow/test_docmodel.py`

- [ ] **Step 1: Write the failing test**

Create `tests/reflow/test_docmodel.py`:

```python
from pdf2fxl.reflow.docmodel import (Doc, Heading, Paragraph, Run, Figure, Table,
                                     Formula, ChapterBreak)


def test_doc_json_round_trip():
    doc = Doc(title="T", language="en", nodes=[
        ChapterBreak(),
        Heading(level=1, text="Chapter One"),
        Paragraph(runs=[Run(text="Hello "), Run(text="world", bold=True)]),
        Figure(src="images/fig-0.png", caption="Fig 1", width_frac=0.5, kind="figure"),
        Table(html="<table></table>", image_src=None, caption="Tab 1"),
        Formula(mathml=None, text="E=mc^2", image_src=None, caption=None),
    ])
    restored = Doc.from_json(doc.to_json())
    assert restored.title == "T"
    assert isinstance(restored.nodes[1], Heading)
    assert restored.nodes[1].level == 1
    assert restored.nodes[2].runs[1].bold is True
    assert isinstance(restored.nodes[3], Figure)
    assert restored.nodes[3].width_frac == 0.5
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/reflow/test_docmodel.py -q`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Write minimal implementation**

Create `src/pdf2fxl/reflow/docmodel.py`:

```python
from __future__ import annotations
from dataclasses import dataclass, field, asdict
from typing import List, Optional, Union
import json


@dataclass
class Run:
    text: str
    bold: bool = False
    italic: bool = False
    dropcap: bool = False


@dataclass
class Heading:
    level: int
    text: str


@dataclass
class Paragraph:
    runs: List[Run] = field(default_factory=list)


@dataclass
class Figure:
    src: str
    caption: Optional[str]
    width_frac: float
    kind: str          # plate | figure | inline


@dataclass
class Table:
    html: Optional[str]
    image_src: Optional[str]
    caption: Optional[str]


@dataclass
class Formula:
    mathml: Optional[str]
    text: Optional[str]
    image_src: Optional[str]
    caption: Optional[str]


@dataclass
class ChapterBreak:
    pass


Node = Union[Heading, Paragraph, Figure, Table, Formula, ChapterBreak]
_KINDS = {"Heading": Heading, "Paragraph": Paragraph, "Figure": Figure,
          "Table": Table, "Formula": Formula, "ChapterBreak": ChapterBreak}


@dataclass
class Doc:
    title: str
    language: str
    nodes: List[Node] = field(default_factory=list)

    def to_json(self) -> str:
        def enc(n):
            d = asdict(n)
            d["_kind"] = type(n).__name__
            return d
        return json.dumps(
            {"title": self.title, "language": self.language,
             "nodes": [enc(n) for n in self.nodes]},
            indent=2, ensure_ascii=False)

    @staticmethod
    def from_json(s: str) -> "Doc":
        d = json.loads(s)
        nodes: List[Node] = []
        for nd in d["nodes"]:
            kind = nd.pop("_kind")
            cls = _KINDS[kind]
            if cls is Paragraph:
                nodes.append(Paragraph(runs=[Run(**r) for r in nd.get("runs", [])]))
            else:
                nodes.append(cls(**nd))
        return Doc(title=d["title"], language=d["language"], nodes=nodes)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/reflow/test_docmodel.py -q`
Expected: PASS (1 passed).

- [ ] **Step 5: Commit**

```bash
git add src/pdf2fxl/reflow/docmodel.py tests/reflow/test_docmodel.py
git commit -m "feat(reflow): Doc model nodes with JSON round-trip"
```

---

## Task 13: Assemble pages into a Doc

**Files:**
- Create: `src/pdf2fxl/reflow/assemble.py`
- Test: `tests/reflow/test_assemble.py`

`build_doc` ties the pipeline together. It takes per-page `(image_bgr, page_size, segments)` plus flags and returns a `Doc`. It measures sizes, normalizes layout, assigns levels, then emits nodes (inserting a `ChapterBreak` before each H1). Image/table segments become `Figure`/`Table` nodes with crops.

- [ ] **Step 1: Write the failing test**

Create `tests/reflow/test_assemble.py`:

```python
import numpy as np
from pdf2fxl.reflow.assemble import build_doc, PageInput
from pdf2fxl.reflow.segment import Segment
from pdf2fxl.reflow.docmodel import Heading, Paragraph, ChapterBreak


def _text_img(page_h=400, page_w=300):
    # 3 body lines (thin bands) + one big heading band near the top
    img = np.full((page_h, page_w), 255, np.uint8)
    img[10:34, 20:280] = 0                       # heading band (~24px thick)
    for i in range(3):
        y = 80 + i * 20
        img[y:y + 8, 20:280] = 0                 # body bands (~8px)
    return np.stack([img] * 3, axis=-1)          # to BGR


def test_build_doc_emits_heading_then_paragraph(tmp_path):
    img = _text_img()
    segs = [
        Segment(0, "title", (20, 10, 260, 24), "Chapter One"),
        Segment(0, "text", (20, 80, 260, 60), "Body sentence one. Body sentence two."),
    ]
    doc = build_doc([PageInput(img, (300, 400), segs)],
                    title="T", language="en", assets_dir=tmp_path)
    kinds = [type(n).__name__ for n in doc.nodes]
    assert "Heading" in kinds and "Paragraph" in kinds
    # ChapterBreak precedes the first heading
    hi = kinds.index("Heading")
    assert "ChapterBreak" in kinds[:hi + 1]
    h = next(n for n in doc.nodes if isinstance(n, Heading))
    assert h.level == 1 and h.text == "Chapter One"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/reflow/test_assemble.py -q`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Write minimal implementation**

Create `src/pdf2fxl/reflow/assemble.py`:

```python
from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Tuple
import cv2

from .segment import Segment, is_heading_type
from .typesize import measure_segment, detect_weight_centering
from .hierarchy import body_size, assign_levels
from .layout import (detect_columns, strip_running, order_segments,
                     merge_dropcaps, rejoin_paragraphs)
from .crop import crop_region, width_frac, classify_image
from .docmodel import (Doc, Heading, Paragraph, Run, Figure, Table, ChapterBreak)


@dataclass
class PageInput:
    image_bgr: "any"
    page_size: Tuple[int, int]     # (w, h)
    segments: List[Segment]


@dataclass
class ReflowOptions:
    layout: str = "auto"           # single | two-up | auto
    tables: str = "html"           # html | image
    figures: str = "image"         # image | drop


def build_doc(pages: List[PageInput], title: str, language: str,
              assets_dir: Path, options: Optional[ReflowOptions] = None) -> Doc:
    options = options or ReflowOptions()
    assets_dir = Path(assets_dir)
    grays = []
    per_page: List[List[Segment]] = []
    for pi, page in enumerate(pages):
        w, h = page.page_size
        gray = cv2.cvtColor(page.image_bgr, cv2.COLOR_BGR2GRAY)
        grays.append(gray)
        for s in page.segments:
            s.page_index = pi
            if s.type not in ("image", "table"):
                measure_segment(gray, s)
                detect_weight_centering(gray, s, page_width=w)
        detect_columns(page.segments, page_width=w, mode=options.layout)
        per_page.append(page.segments)

    ph = pages[0].page_size[1] if pages else 1000
    per_page = strip_running(per_page, page_height=ph)

    flat: List[Segment] = [s for page in per_page for s in page]
    body_px = body_size(flat)
    assign_levels(flat)
    ordered = order_segments(flat)
    ordered = merge_dropcaps(ordered, body_px=body_px)
    ordered = rejoin_paragraphs(ordered)

    nodes: List = []
    img_i = 0
    for s in ordered:
        page = pages[s.page_index]
        w, h = page.page_size
        col_w = w / 2 if any(x.column == 1 for x in per_page[s.page_index]) else w
        if s.type == "image" or (s.type == "table" and options.tables == "image"):
            if s.type == "image" and options.figures == "drop":
                continue
            src = crop_region(page.image_bgr, s.bbox,
                              assets_dir / f"img-{img_i:03d}.png"); img_i += 1
            rel = f"images/{src.name}"
            area = (s.bbox[2] * s.bbox[3]) / (w * h)
            if s.type == "table":
                nodes.append(Table(html=None, image_src=rel, caption=None))
            else:
                nodes.append(Figure(src=rel, caption=None,
                                    width_frac=width_frac(s.bbox[2], col_w),
                                    kind=classify_image(area)))
        elif s.type == "table":
            nodes.append(Table(html=s.text or "<table></table>", image_src=None,
                              caption=None))
        elif is_heading_type(s.type):
            if s.level == 1:
                nodes.append(ChapterBreak())
            nodes.append(Heading(level=max(1, s.level), text=s.text))
        else:
            nodes.append(Paragraph(runs=[Run(text=s.text, bold=s.bold)]))
    return Doc(title=title, language=language, nodes=nodes)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/reflow/test_assemble.py -q`
Expected: PASS (1 passed).

- [ ] **Step 5: Commit**

```bash
git add src/pdf2fxl/reflow/assemble.py tests/reflow/test_assemble.py
git commit -m "feat(reflow): assemble measured/ordered segments into a Doc"
```

---

## Task 14: Markdown renderer

**Files:**
- Create: `src/pdf2fxl/reflow/render_md.py`
- Test: `tests/reflow/test_render_md.py`

- [ ] **Step 1: Write the failing test**

Create `tests/reflow/test_render_md.py`:

```python
from pdf2fxl.reflow.render_md import render_markdown
from pdf2fxl.reflow.docmodel import (Doc, Heading, Paragraph, Run, Figure, Table,
                                     ChapterBreak)


def test_markdown_headings_paragraphs_figures():
    doc = Doc(title="T", language="en", nodes=[
        ChapterBreak(),
        Heading(level=1, text="Chapter One"),
        Heading(level=2, text="Section"),
        Paragraph(runs=[Run(text="Hello "), Run(text="bold", bold=True)]),
        Figure(src="images/f.png", caption="Cap", width_frac=0.5, kind="figure"),
        Table(html="<table><tr><td>a</td></tr></table>", image_src=None, caption=None),
    ])
    md = render_markdown(doc)
    assert "# Chapter One" in md
    assert "## Section" in md
    assert "Hello **bold**" in md
    assert "![Cap](images/f.png)" in md
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/reflow/test_render_md.py -q`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Write minimal implementation**

Create `src/pdf2fxl/reflow/render_md.py`:

```python
from __future__ import annotations

from .docmodel import Doc, Heading, Paragraph, Figure, Table, Formula, ChapterBreak


def _runs_md(runs) -> str:
    out = []
    for r in runs:
        t = r.text
        if r.bold:
            t = f"**{t}**"
        if r.italic:
            t = f"*{t}*"
        out.append(t)
    return "".join(out)


def render_markdown(doc: Doc) -> str:
    lines = [f"# {doc.title}", ""]
    for n in doc.nodes:
        if isinstance(n, ChapterBreak):
            continue
        if isinstance(n, Heading):
            lines += ["#" * min(6, max(1, n.level)) + f" {n.text}", ""]
        elif isinstance(n, Paragraph):
            lines += [_runs_md(n.runs), ""]
        elif isinstance(n, Figure):
            lines += [f"![{n.caption or ''}]({n.src})", ""]
        elif isinstance(n, Table):
            lines += [n.image_src and f"![]({n.image_src})" or (n.html or ""), ""]
        elif isinstance(n, Formula):
            lines += [n.text or (n.image_src and f"![]({n.image_src})") or "", ""]
    return "\n".join(lines).strip() + "\n"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/reflow/test_render_md.py -q`
Expected: PASS (1 passed).

- [ ] **Step 5: Commit**

```bash
git add src/pdf2fxl/reflow/render_md.py tests/reflow/test_render_md.py
git commit -m "feat(reflow): Markdown renderer"
```

---

## Task 15: DOCX renderer

**Files:**
- Create: `src/pdf2fxl/reflow/render_docx.py`
- Test: `tests/reflow/test_render_docx.py`

- [ ] **Step 1: Write the failing test**

Create `tests/reflow/test_render_docx.py`:

```python
from docx import Document
from pdf2fxl.reflow.render_docx import render_docx
from pdf2fxl.reflow.docmodel import Doc, Heading, Paragraph, Run, ChapterBreak


def test_docx_has_heading_and_paragraph(tmp_path):
    doc = Doc(title="T", language="en", nodes=[
        ChapterBreak(),
        Heading(level=1, text="Chapter One"),
        Paragraph(runs=[Run(text="Body text here.")]),
    ])
    out = tmp_path / "out.docx"
    render_docx(doc, out, assets_root=tmp_path)
    assert out.exists()
    d = Document(str(out))
    texts = [p.text for p in d.paragraphs]
    assert "Chapter One" in texts
    assert "Body text here." in texts
    styles = [p.style.name for p in d.paragraphs if p.text == "Chapter One"]
    assert styles and styles[0].startswith("Heading")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/reflow/test_render_docx.py -q`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Write minimal implementation**

Create `src/pdf2fxl/reflow/render_docx.py`:

```python
from __future__ import annotations
from pathlib import Path

from docx import Document
from docx.shared import Inches

from .docmodel import Doc, Heading, Paragraph, Figure, Table, Formula, ChapterBreak


def render_docx(doc: Doc, out_path: Path, assets_root: Path) -> Path:
    d = Document()
    d.core_properties.title = doc.title
    for n in doc.nodes:
        if isinstance(n, ChapterBreak):
            if len(d.paragraphs) > 1:
                d.add_page_break()
        elif isinstance(n, Heading):
            d.add_heading(n.text, level=min(9, max(1, n.level)))
        elif isinstance(n, Paragraph):
            p = d.add_paragraph()
            for r in n.runs:
                run = p.add_run(r.text)
                run.bold = r.bold
                run.italic = r.italic
        elif isinstance(n, (Figure, Table)) and getattr(n, "image_src", None) or (
                isinstance(n, Figure) and n.src):
            src = n.src if isinstance(n, Figure) else n.image_src
            path = Path(assets_root) / Path(src).name
            if path.exists():
                width = Inches(6.0 * getattr(n, "width_frac", 1.0)) if isinstance(n, Figure) else Inches(6.0)
                d.add_picture(str(path), width=width)
            if getattr(n, "caption", None):
                d.add_paragraph(n.caption)
        elif isinstance(n, Formula) and n.text:
            d.add_paragraph(n.text)
    out_path = Path(out_path)
    d.save(str(out_path))
    return out_path
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/reflow/test_render_docx.py -q`
Expected: PASS (1 passed).

- [ ] **Step 5: Commit**

```bash
git add src/pdf2fxl/reflow/render_docx.py tests/reflow/test_render_docx.py
git commit -m "feat(reflow): DOCX renderer"
```

---

## Task 16: Reflowable EPUB renderer

**Files:**
- Create: `src/pdf2fxl/reflow/render_epub_reflow.py`
- Test: `tests/reflow/test_render_epub_reflow.py`

Mirrors `render_epub.py`'s manual zip packaging, but: reflowable OPF (no `pre-paginated`), one XHTML per chapter (split on `ChapterBreak`), `nav.xhtml` from headings, semantic tags, `@font-face` via `font_family()`.

- [ ] **Step 1: Write the failing test**

Create `tests/reflow/test_render_epub_reflow.py`:

```python
import zipfile
from pathlib import Path
from pdf2fxl.reflow.render_epub_reflow import write_epub_reflow
from pdf2fxl.reflow.docmodel import Doc, Heading, Paragraph, Run, ChapterBreak

FONT = "assets/fonts/NotoSerif-Regular.ttf"


def test_epub_structure_and_chapter_split(tmp_path):
    doc = Doc(title="T", language="en", nodes=[
        ChapterBreak(), Heading(level=1, text="One"),
        Paragraph(runs=[Run(text="Alpha body.")]),
        ChapterBreak(), Heading(level=1, text="Two"),
        Paragraph(runs=[Run(text="Beta body.")]),
    ])
    out = write_epub_reflow(doc, tmp_path / "b.epub", font_path=FONT,
                            assets_root=tmp_path)
    assert out.exists()
    with zipfile.ZipFile(out) as z:
        names = z.namelist()
        assert "mimetype" in names
        assert "OEBPS/nav.xhtml" in names
        chapters = [n for n in names if n.startswith("OEBPS/chap-")]
        assert len(chapters) == 2                      # one file per H1
        nav = z.read("OEBPS/nav.xhtml").decode()
        assert "One" in nav and "Two" in nav
        c0 = z.read(chapters[0]).decode()
        assert "<h1" in c0 and "Alpha body." in c0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/reflow/test_render_epub_reflow.py -q`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Write minimal implementation**

Create `src/pdf2fxl/reflow/render_epub_reflow.py`:

```python
from __future__ import annotations
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Tuple
import html
import uuid
import zipfile

from ..fittext import font_family
from .docmodel import (Doc, Heading, Paragraph, Figure, Table, Formula, ChapterBreak)

CONTAINER_XML = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf"
     media-type="application/oebps-package+xml"/></rootfiles>
</container>
"""


def _css(font_file: str, family: str) -> str:
    return f"""@font-face {{ font-family: "{family}"; src: url("fonts/{font_file}"); }}
html, body {{ font-family: "{family}", serif; line-height: 1.5; margin: 1em; }}
h1, h2, h3, h4, h5, h6 {{ line-height: 1.2; }}
figure {{ margin: 1em 0; text-align: center; }}
img {{ max-width: 100%; height: auto; }}
figcaption {{ font-size: 0.9em; color: #444; }}
"""


def _runs_html(runs) -> str:
    out = []
    for r in runs:
        t = html.escape(r.text)
        if r.bold:
            t = f"<strong>{t}</strong>"
        if r.italic:
            t = f"<em>{t}</em>"
        out.append(t)
    return "".join(out)


def _node_html(n) -> str:
    if isinstance(n, Heading):
        lvl = min(6, max(1, n.level))
        return f"<h{lvl}>{html.escape(n.text)}</h{lvl}>"
    if isinstance(n, Paragraph):
        return f"<p>{_runs_html(n.runs)}</p>"
    if isinstance(n, Figure):
        cap = f"<figcaption>{html.escape(n.caption)}</figcaption>" if n.caption else ""
        return (f'<figure><img src="{html.escape(n.src)}" '
                f'style="width:{n.width_frac * 100:.1f}%" alt=""/>{cap}</figure>')
    if isinstance(n, Table):
        if n.image_src:
            return f'<figure><img src="{html.escape(n.image_src)}" alt=""/></figure>'
        return n.html or ""
    if isinstance(n, Formula):
        if n.mathml:
            return n.mathml
        if n.image_src:
            return f'<figure><img src="{html.escape(n.image_src)}" alt=""/></figure>'
        return f"<p>{html.escape(n.text or '')}</p>"
    return ""


def _split_chapters(nodes) -> List[List]:
    chapters: List[List] = []
    cur: List = []
    for n in nodes:
        if isinstance(n, ChapterBreak):
            if cur:
                chapters.append(cur)
            cur = []
        else:
            cur.append(n)
    if cur:
        chapters.append(cur)
    return chapters or [[]]


def _chapter_xhtml(nodes, title: str) -> str:
    body = "\n".join(_node_html(n) for n in nodes)
    return f"""<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><meta charset="utf-8"/><title>{html.escape(title)}</title>
<link rel="stylesheet" type="text/css" href="styles/reflow.css"/></head>
<body>{body}</body></html>
"""


def _chapter_title(nodes, fallback: str) -> str:
    for n in nodes:
        if isinstance(n, Heading):
            return n.text
    return fallback


def _nav(chapters, titles, book_title: str) -> str:
    lis = "".join(f'<li><a href="chap-{i:03d}.xhtml">{html.escape(t)}</a></li>'
                  for i, t in enumerate(titles))
    return f"""<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><meta charset="utf-8"/><title>{html.escape(book_title)}</title></head>
<body><nav epub:type="toc" id="toc"><ol>{lis}</ol></nav></body></html>
"""


def _opf(chapters, images: List[str], title, language, font_name, modified) -> str:
    book_uuid = uuid.uuid5(uuid.NAMESPACE_DNS, "pdf2fxl-reflow:" + title)
    manifest = [
        '<item id="css" href="styles/reflow.css" media-type="text/css"/>',
        f'<item id="font" href="fonts/{font_name}" media-type="application/font-sfnt"/>',
        '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    ]
    spine = []
    for i, _ in enumerate(chapters):
        manifest.append(f'<item id="chap{i}" href="chap-{i:03d}.xhtml" '
                        'media-type="application/xhtml+xml"/>')
        spine.append(f'<itemref idref="chap{i}"/>')
    for j, img in enumerate(images):
        manifest.append(f'<item id="im{j}" href="images/{img}" media-type="image/png"/>')
    return f"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:{book_uuid}</dc:identifier>
    <dc:title>{html.escape(title)}</dc:title>
    <dc:language>{language}</dc:language>
    <meta property="dcterms:modified">{modified}</meta>
  </metadata>
  <manifest>{"".join(manifest)}</manifest>
  <spine>{"".join(spine)}</spine>
</package>
"""


def write_epub_reflow(doc: Doc, out_path: Path, font_path: str,
                      assets_root: Path) -> Path:
    out_path = Path(out_path)
    assets_root = Path(assets_root)
    font_name = Path(font_path).name
    family = font_family(font_path)
    modified = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    chapters = _split_chapters(doc.nodes)
    titles = [_chapter_title(ch, f"Chapter {i+1}") for i, ch in enumerate(chapters)]
    images: List[str] = []
    for n in doc.nodes:
        src = getattr(n, "src", None) or getattr(n, "image_src", None)
        if src:
            images.append(Path(src).name)
    with zipfile.ZipFile(out_path, "w") as z:
        z.writestr("mimetype", "application/epub+zip", zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", CONTAINER_XML, zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/styles/reflow.css", _css(font_name, family), zipfile.ZIP_DEFLATED)
        z.write(font_path, f"OEBPS/fonts/{font_name}", zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/content.opf",
                   _opf(chapters, images, doc.title, doc.language, font_name, modified),
                   zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/nav.xhtml", _nav(chapters, titles, doc.title), zipfile.ZIP_DEFLATED)
        for i, ch in enumerate(chapters):
            z.writestr(f"OEBPS/chap-{i:03d}.xhtml", _chapter_xhtml(ch, titles[i]),
                       zipfile.ZIP_DEFLATED)
        for img in images:
            p = assets_root / img
            if p.exists():
                z.write(str(p), f"OEBPS/images/{img}", zipfile.ZIP_DEFLATED)
    return out_path
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/reflow/test_render_epub_reflow.py -q`
Expected: PASS (1 passed).

- [ ] **Step 5: Commit**

```bash
git add src/pdf2fxl/reflow/render_epub_reflow.py tests/reflow/test_render_epub_reflow.py
git commit -m "feat(reflow): reflowable EPUB3 renderer with per-chapter spine + nav"
```

---

## Task 17: Config fields for reflow

**Files:**
- Modify: `src/pdf2fxl/config.py:9-24`
- Test: `tests/reflow/test_config_reflow.py`

- [ ] **Step 1: Write the failing test**

Create `tests/reflow/test_config_reflow.py`:

```python
from pdf2fxl.config import Config


def test_reflow_defaults():
    c = Config()
    assert c.mode == "fxl"
    assert c.reflow_formats == ("epub", "md", "docx")
    assert c.reflow_tables == "html"
    assert c.reflow_figures == "image"
    assert c.reflow_formulas == "image"
    assert c.reflow_layout == "auto"
    assert c.promote_runins is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/reflow/test_config_reflow.py -q`
Expected: FAIL — `AttributeError: 'Config' object has no attribute 'mode'`.

- [ ] **Step 3: Write minimal implementation**

Add these fields to the `Config` dataclass in `src/pdf2fxl/config.py` (after the existing fields, before `font_map`):

```python
    mode: str = "fxl"                              # "fxl" | "reflow"
    reflow_formats: Tuple[str, ...] = ("epub", "md", "docx")
    reflow_tables: str = "html"                    # "html" | "image"
    reflow_figures: str = "image"                  # "image" | "drop"
    reflow_formulas: str = "image"                 # "mathml" | "image" | "text"
    reflow_layout: str = "auto"                    # "single" | "two-up" | "auto"
    promote_runins: bool = False
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/reflow/test_config_reflow.py -q`
Expected: PASS (1 passed).

- [ ] **Step 5: Commit**

```bash
git add src/pdf2fxl/config.py tests/reflow/test_config_reflow.py
git commit -m "feat(reflow): config fields for mode, formats, fidelity, layout"
```

---

## Task 18: Pipeline branch — convert_book_reflow

**Files:**
- Create: `src/pdf2fxl/reflow/pipeline_reflow.py`
- Test: `tests/reflow/test_pipeline_reflow.py`

Reuses ingest (`rasterize_page`, `trim_page`/`trimbox_px`, `page_count`) + a fake/real OCR fn; skips inpaint. Produces EPUB/MD/DOCX per `reflow_formats`.

- [ ] **Step 1: Write the failing test**

Create `tests/reflow/test_pipeline_reflow.py`:

```python
import numpy as np
from pathlib import Path
from pdf2fxl.config import Config
from pdf2fxl.reflow.pipeline_reflow import convert_book_reflow

FONT = "assets/fonts/NotoSerif-Regular.ttf"

FAKE_RESP = {"pages": [{
    "dimensions": {"width": 300, "height": 400},
    "blocks": [
        {"type": "title", "top_left_x": 20, "top_left_y": 10,
         "bottom_right_x": 280, "bottom_right_y": 34, "content": "# Chapter One"},
        {"type": "text", "top_left_x": 20, "top_left_y": 80,
         "bottom_right_x": 280, "bottom_right_y": 140,
         "content": "Body sentence one. Body sentence two."},
    ],
}]}


def _fake_ocr(image_bgr, cfg, api_key):
    return FAKE_RESP


def _fake_pages(monkeypatch):
    import pdf2fxl.reflow.pipeline_reflow as mod
    img = np.full((400, 300, 3), 255, np.uint8)
    img[10:34, 20:280] = 0
    for i in range(3):
        img[80 + i * 20:88 + i * 20, 20:280] = 0
    monkeypatch.setattr(mod, "page_count", lambda p: 1)
    monkeypatch.setattr(mod, "rasterize_page", lambda p, i, z: img)
    monkeypatch.setattr(mod, "trimbox_px", lambda p, i, z: None)
    monkeypatch.setattr(mod, "trim_page", lambda im, trim=None: im)


def test_convert_book_reflow_writes_all_formats(tmp_path, monkeypatch):
    _fake_pages(monkeypatch)
    cfg = Config(mode="reflow")
    outputs = convert_book_reflow("dummy.pdf", tmp_path, cfg=cfg, ocr_fn=_fake_ocr,
                                  api_key="x", title="Book", language="en",
                                  font_path=FONT)
    kinds = {p.suffix for p in outputs}
    assert ".epub" in kinds and ".md" in kinds and ".docx" in kinds
    assert all(p.exists() for p in outputs)
    md = next(p for p in outputs if p.suffix == ".md").read_text()
    assert "# Chapter One" in md
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/reflow/test_pipeline_reflow.py -q`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Write minimal implementation**

Create `src/pdf2fxl/reflow/pipeline_reflow.py`:

```python
from __future__ import annotations
from pathlib import Path
from typing import Callable, List, Optional
import cv2

from ..config import Config
from ..ingest import rasterize_page, trim_page, page_count, trimbox_px
from .ocr_reflow import parse_ocr_reflow
from .assemble import build_doc, PageInput, ReflowOptions
from .render_md import render_markdown
from .render_docx import render_docx
from .render_epub_reflow import write_epub_reflow

OcrFn = Callable[..., dict]


def _trim(img, cfg: Config, pdf_path: str, index: int):
    if cfg.trim_strategy == "none":
        return img
    box = None
    if cfg.trim_strategy in ("auto", "trimbox"):
        box = trimbox_px(pdf_path, index, cfg.zoom)
    return trim_page(img, trim=box)


def convert_book_reflow(pdf_path: str, out_dir: Path, cfg: Optional[Config] = None,
                        ocr_fn: Optional[OcrFn] = None, api_key: str = "",
                        title: str = "Untitled", language: str = "en",
                        font_path: str = "assets/fonts/NotoSerif-Regular.ttf"
                        ) -> List[Path]:
    cfg = cfg or Config(mode="reflow")
    ocr_fn = ocr_fn or __import__("pdf2fxl.ocr", fromlist=["run_ocr"]).run_ocr
    out_dir = Path(out_dir); out_dir.mkdir(parents=True, exist_ok=True)
    images_dir = out_dir / "images"; images_dir.mkdir(parents=True, exist_ok=True)

    page_inputs: List[PageInput] = []
    for i in range(page_count(pdf_path)):
        raw = rasterize_page(pdf_path, i, cfg.zoom)
        img = _trim(raw, cfg, pdf_path, i)
        h, w = img.shape[:2]
        resp = ocr_fn(img, cfg, api_key)
        segs = parse_ocr_reflow(resp, (w, h))
        page_inputs.append(PageInput(image_bgr=img, page_size=(w, h), segments=segs))

    options = ReflowOptions(layout=cfg.reflow_layout, tables=cfg.reflow_tables,
                            figures=cfg.reflow_figures)
    doc = build_doc(page_inputs, title=title, language=language,
                    assets_dir=images_dir, options=options)
    (out_dir / f"{title}.doc.json").write_text(doc.to_json(), encoding="utf-8")

    outputs: List[Path] = []
    if "md" in cfg.reflow_formats:
        p = out_dir / f"{title}.md"; p.write_text(render_markdown(doc), encoding="utf-8")
        outputs.append(p)
    if "docx" in cfg.reflow_formats:
        outputs.append(render_docx(doc, out_dir / f"{title}.docx", assets_root=images_dir))
    if "epub" in cfg.reflow_formats:
        outputs.append(write_epub_reflow(doc, out_dir / f"{title}.epub",
                                         font_path=font_path, assets_root=images_dir))
    return outputs
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/reflow/test_pipeline_reflow.py -q`
Expected: PASS (1 passed).

- [ ] **Step 5: Commit**

```bash
git add src/pdf2fxl/reflow/pipeline_reflow.py tests/reflow/test_pipeline_reflow.py
git commit -m "feat(reflow): convert_book_reflow pipeline (EPUB/MD/DOCX)"
```

---

## Task 19: CLI wiring (`--mode reflow` + flags)

**Files:**
- Modify: `src/pdf2fxl/cli.py`
- Test: `tests/reflow/test_cli_reflow.py`

- [ ] **Step 1: Write the failing test**

Create `tests/reflow/test_cli_reflow.py`:

```python
from click.testing import CliRunner
from unittest import mock
from pathlib import Path
from pdf2fxl.cli import main


def test_cli_reflow_dispatches_to_reflow_pipeline(tmp_path):
    pdf = tmp_path / "in.pdf"; pdf.write_bytes(b"%PDF-1.4\n")
    runner = CliRunner()
    with mock.patch("pdf2fxl.cli.convert_book_reflow") as m:
        m.return_value = [tmp_path / "Book.epub"]
        res = runner.invoke(main, [str(pdf), "-o", str(tmp_path), "--mode", "reflow",
                                   "--title", "Book", "--tables", "image",
                                   "--layout", "two-up"],
                            env={"MISTRAL_API_KEY": "x"})
    assert res.exit_code == 0, res.output
    assert m.called
    cfg = m.call_args.kwargs["cfg"]
    assert cfg.mode == "reflow"
    assert cfg.reflow_tables == "image"
    assert cfg.reflow_layout == "two-up"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/reflow/test_cli_reflow.py -q`
Expected: FAIL — reflow options unknown / `convert_book_reflow` not imported.

- [ ] **Step 3: Write minimal implementation**

Edit `src/pdf2fxl/cli.py`. Add the import near the top:

```python
from .reflow.pipeline_reflow import convert_book_reflow
```

Add these options to `main` (after `--dpi`):

```python
@click.option("--mode", type=click.Choice(["fxl", "reflow"]), default="fxl",
              show_default=True, help="Output mode.")
@click.option("--formats", default="epub,md,docx", show_default=True,
              help="Reflow outputs (comma list of epub,md,docx).")
@click.option("--tables", type=click.Choice(["html", "image"]), default="html",
              show_default=True)
@click.option("--figures", type=click.Choice(["image", "drop"]), default="image",
              show_default=True)
@click.option("--formulas", type=click.Choice(["mathml", "image", "text"]),
              default="image", show_default=True)
@click.option("--layout", type=click.Choice(["single", "two-up", "auto"]),
              default="auto", show_default=True)
@click.option("--promote-runins", is_flag=True, default=False)
```

Update the `main` signature to accept the new params and branch. Replace the body from `cfg = Config(zoom=dpi / 72)` onward with:

```python
    title = title or Path(pdf).stem
    if mode == "reflow":
        cfg = Config(zoom=dpi / 72, mode="reflow",
                     reflow_formats=tuple(f.strip() for f in formats.split(",") if f.strip()),
                     reflow_tables=tables, reflow_figures=figures,
                     reflow_formulas=formulas, reflow_layout=layout,
                     promote_runins=promote_runins)
        outputs = convert_book_reflow(pdf, Path(out_dir), cfg=cfg, api_key=api_key,
                                      title=title, language=language, font_path=font_path)
        for p in outputs:
            click.echo(f"Wrote {p}")
        return
    cfg = Config(zoom=dpi / 72)
    epub, pptx = convert_book(pdf, Path(out_dir), cfg=cfg, api_key=api_key,
                              title=title, language=language, font_path=font_path)
    click.echo(f"Wrote {epub}")
    click.echo(f"Wrote {pptx}")
```

Update the signature line to:

```python
def main(pdf: str, out_dir: str, title: str, language: str, font_path: str,
         dpi: int, mode: str, formats: str, tables: str, figures: str,
         formulas: str, layout: str, promote_runins: bool) -> None:
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/reflow/test_cli_reflow.py -q && pytest tests/test_cli.py -q`
Expected: PASS (reflow CLI test passes; existing CLI tests still pass).

- [ ] **Step 5: Commit**

```bash
git add src/pdf2fxl/cli.py tests/reflow/test_cli_reflow.py
git commit -m "feat(reflow): CLI --mode reflow with format/fidelity/layout flags"
```

---

## Task 20: Full suite green + README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Run the whole fast suite**

Run: `pytest -q -m 'not slow'`
Expected: PASS — all existing + all `tests/reflow/` tests green.

- [ ] **Step 2: Add reflow usage to README**

Add this section to `README.md` after the `## Use` section:

```markdown
## Reflow mode (scanned text books → reflowable EPUB / Markdown / DOCX)

For text books (not picture books), recover a reflowable document with a
book-global heading hierarchy computed from OCR geometry:

    pdf2fxl book.pdf -o out/ --title "Book" --mode reflow

Options:
    --formats epub,md,docx     # which outputs (default all three)
    --tables html|image        # real <table> vs cropped from the scan
    --figures image|drop       # crop figures, or omit them
    --formulas mathml|image|text
    --layout single|two-up|auto   # two-up = two book pages per scan
    --font <ttf>               # embed a script-specific face (e.g. Devanagari)

Heading levels are derived from measured type size (clustered across the whole
book) reconciled with section numbering — Mistral's per-page hierarchy is not
trusted, but its heading-vs-not classification is.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document reflow mode usage"
```

---

## Task 21: Visual verification on the three real books (manual gate)

> **Project hard rule (memory):** never trust geometry/unit tests for visual output. This gate is required before declaring the feature done.

**Files:** none (produces artifacts under `out/` and screenshots).

- [ ] **Step 1: Run all three books through reflow**

```bash
export MISTRAL_API_KEY=...   # or rely on .env
pdf2fxl "/Users/siraj/Downloads/Dysbiosis_of_the_Evolved_Intestinal_Microbiome.pdf" \
  -o out/dysbiosis --title "Dysbiosis" --mode reflow
pdf2fxl "/Users/siraj/Downloads/Antimicrobial__Alternatives_Against_Resilient_Oral_Biofilms.pdf" \
  -o out/biofilms --title "Biofilms" --mode reflow
pdf2fxl "/Users/siraj/Downloads/baliche-rajey-yenar-aahe-sharad-joshi.pdf" \
  -o out/baliche --title "Baliche" --mode reflow \
  --font assets/fonts/NotoSerifDevanagari-Regular.ttf --layout two-up
```

Expected: each writes `.epub`, `.md`, `.docx`, and a `.doc.json`.

- [ ] **Step 2: Check the recovered hierarchy in Markdown**

Run: `grep -E '^#{1,6} ' out/biofilms/Biofilms.md | head -40`
Expected: `# 1. Microbial Complex Ecosystems...`, `## 1.1. Introduction`, `### 1.2.1. Early Discoveries...` — numbering depth matches heading level. For `out/dysbiosis/Dysbiosis.md` expect `# Preface`, `## What is the Intestinal Microbiome?`. For `out/baliche/Baliche.md` expect chapter titles as `#` with no numbering.

- [ ] **Step 3: Render each EPUB and eyeball**

Open each `.epub` in Apple Books (or render `chap-000.xhtml` in headless Chrome). Confirm: reading order correct (Marathi left-page-then-right), no running headers/footers in body text, drop caps merged into their paragraph (not headings), figures present at sensible widths, the biofilms table present (as `<table>` by default), the `<nav>` TOC outline matches the real book structure.

- [ ] **Step 4: Validate EPUBs (if epubcheck available)**

Run: `epubcheck out/biofilms/Biofilms.epub`
Expected: no errors (warnings acceptable). Skip if epubcheck is not installed.

- [ ] **Step 5: Record results**

Note any hierarchy or layout misfires (with page/heading examples) for a follow-up pass. If clean, the feature is verified.

---

## Self-review notes (already reconciled)

- **Spec coverage:** measurement §5.1 → Tasks 3–4; body/tiers/numbering §5.2–5.3 → Tasks 5–7; layout §6 → Tasks 8–10; images §5.4 → Task 11; Doc model §8 → Task 12; assembly → Task 13; three renderers §4.1 → Tasks 14–16; config/CLI §7 → Tasks 17–19; verification §9 → Tasks 20–21. Run-in promotion flag is plumbed through config/CLI (Tasks 17, 19); honoring it in `build_doc` is deferred (headings come from Mistral typing, so default-off requires no code — noted for a follow-up if enabled).
- **Type consistency:** `Segment` fields and function names (`measure_segment`, `detect_weight_centering`, `body_size`, `parse_numbering`, `assign_levels`, `detect_columns`, `strip_running`, `order_segments`, `merge_dropcaps`, `rejoin_paragraphs`, `crop_region`, `width_frac`, `classify_image`, `build_doc`, `render_markdown`, `render_docx`, `write_epub_reflow`, `convert_book_reflow`) are used identically across tasks.
- **Formulas:** the `Formula` node and `--formulas` flag exist; emission of formula crops is handled the same way as figures in `build_doc` when Mistral emits a formula/equation block type (falls through to the image/text branch). No separate task needed.
