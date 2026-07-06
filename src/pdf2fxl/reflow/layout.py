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
        mid_gap = (a + b) / 2
        if 0.3 * page_width < mid_gap < 0.7 * page_width:
            if b - a > best_gap:
                best_gap, split = b - a, mid_gap
    if split is not None and best_gap > 0.12 * page_width:
        for s in segments:
            s.column = 0 if (s.bbox[0] + s.bbox[2] / 2) < split else 1
    else:
        for s in segments:
            s.column = 0


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


from .segment import is_heading_type

_SENT_END = tuple(".!?।॥\"')]")   # incl. Devanagari danda/double danda

# A leading section number ("5 ", "2.1. ", "IV. ") that must never be stripped.
_LEADING_NUM = _re.compile(r"^\s*(?:\d+(?:\.\d+)*\.?|[IVXLCDM]+\.|[०-९]+[.।]?)\s+")
# A dot-leader run: 3+ dots, optionally spaced ("....", ". . .").
_DOT_LEADERS = _re.compile(r"(?:\.\s?){3,}")
# Classic TOC shape: "title  ....  N" or "title <dot-leaders> N".
_TOC_SHAPE = _re.compile(r"^.+\s+\.{2,}.*\d+\s*$")


def strip_heading_page_number(text: str) -> str:
    """Remove a trailing standalone page number from a heading's text.

    Strips a run of 1-4 trailing digits ONLY when it is clearly a page number:
    separated by whitespace, and the remaining heading still has >= 2 other
    words after removing any leading section number. Never touches leading
    chapter numbers, dotted section numbers, or headings that are only a
    number (those are left to strip_running)."""
    if not text:
        return text
    m = _re.match(r"^(.*?)\s+(\d{1,4})\s*$", text)
    if not m:
        return text
    head = m.group(1).rstrip()
    if not head:
        return text  # heading is only a number
    # Count words after dropping any leading section number, so "5 The Holobiont"
    # (leading "5") still counts "The", "Holobiont" but "Chapter 21" -> "Chapter"
    # (one word) is preserved.
    body = _LEADING_NUM.sub("", head, count=1)
    if len(body.split()) < 2:
        return text
    return head


def is_toc_line(text: str) -> bool:
    """A table-of-contents line: has a dot-leader run, or the classic
    "title  ....  page-number" shape."""
    if not text:
        return False
    if _DOT_LEADERS.search(text):
        return True
    if _TOC_SHAPE.match(text):
        return True
    return False


def clean_headings(segments: List[Segment]) -> None:
    """In place: demote TOC-style heading blocks to normal text, and strip
    trailing page numbers from the remaining real headings. Run BEFORE level
    assignment so demoted lines never get a heading level. Non-heading blocks
    are left untouched."""
    for s in segments:
        if not is_heading_type(s.type):
            continue
        if is_toc_line(s.text):
            s.type = "text"
            continue
        s.text = strip_heading_page_number(s.text)


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
