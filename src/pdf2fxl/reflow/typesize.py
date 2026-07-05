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
