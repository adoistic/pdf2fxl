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
