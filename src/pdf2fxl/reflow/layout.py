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
