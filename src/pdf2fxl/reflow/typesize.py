from __future__ import annotations
from typing import List, Tuple
import numpy as np

from .segment import Segment

# Lines are counted by PEAKS in the row-ink projection, not by band-thresholding.
# Each text line makes one dominant peak (its x-height core); ascender/descender
# rows are lower shoulders that stay below PEAK_FRAC of the line's peak, so they
# do NOT spawn spurious extra lines. This is scale-free: it counts 48pt headings
# and 10pt body correctly, where a fixed-pixel band threshold could not (validated
# empirically). SMOOTH_SIGMA just denoises the projection before peak-finding.
SMOOTH_SIGMA = 1.0
PEAK_FRAC = 0.3        # a projection region >= this fraction of the block's max
                       # row-ink is a candidate line; its peak is the argmax within it.
MERGE_VALLEY = 0.5     # adjacent candidate lines are the SAME line when the valley
                       # between them stays above this fraction of the smaller peak
                       # (a shallow intra-line ascender/descender dip); only a deep
                       # valley (a real inter-line leading gap) splits them.


def _gaussian1d(a: np.ndarray, sigma: float) -> np.ndarray:
    """Small dependency-free 1-D Gaussian smoother (avoids importing scipy)."""
    if sigma <= 0:
        return a.astype(float)
    radius = max(1, int(round(3.0 * sigma)))
    xs = np.arange(-radius, radius + 1, dtype=float)
    k = np.exp(-(xs * xs) / (2.0 * sigma * sigma))
    k /= k.sum()
    # 'same' length, edge-reflected to avoid darkening the first/last rows
    pad = np.pad(a.astype(float), radius, mode="reflect")
    return np.convolve(pad, k, mode="valid")


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
    """Set seg.size_px (median ink-band thickness — UNCHANGED semantics, for
    body_size and dropcap detection), seg.n_lines (reliable line count), and stash
    seg._pitch_px / seg._band_px (content-invariant size features consumed later by
    finalize_line_sizes). Mutates seg in place.

    Line detection is done on the SMOOTHED, RELATIVE-FLOOR projection so that
    (a) an interior 1-2px dropout does not split one visual line into two, and
    (b) sparse ascender/descender tails do not inflate band thickness. This makes
    n_lines reliable and the stashed pitch content-invariant, while size_px keeps
    its original meaning for backward compatibility.
    """
    x, y, w, h = (int(round(v)) for v in seg.bbox)
    x = max(0, x); y = max(0, y)
    crop = gray[y:y + h, x:x + w]
    if crop.size == 0 or crop.shape[1] == 0:
        return

    # --- legacy size_px path: UNCHANGED absolute-floor band thickness ---
    ink_per_row = (crop < dark_thresh).sum(axis=1)
    row_has_ink = ink_per_row > max(1.0, 0.02 * crop.shape[1])
    legacy_bands = _runs(row_has_ink)
    if legacy_bands:
        seg.size_px = float(np.median([e - s for s, e in legacy_bands]))

    # --- new robust path: peak-counted lines + per-line ink height ---
    p_s = _gaussian1d(ink_per_row.astype(float), SMOOTH_SIGMA)
    if p_s.max() <= 0:
        seg.n_lines = 1
        return
    above = p_s >= PEAK_FRAC * p_s.max()
    bands = _runs(above)                                    # maximal above-threshold runs
    # Merge adjacent runs separated only by a SHALLOW valley (an intra-line
    # ascender/descender dip, common in descender-heavy lines) so each real text
    # line is counted once; a deep valley (real leading gap) keeps them apart.
    merged: List[Tuple[int, int, float]] = []               # (start, end, peak)
    for s, e in bands:
        peak = float(p_s[s:e].max())
        if merged:
            ps, pe, ppk = merged[-1]
            valley = float(p_s[pe:s].min()) if s > pe else 0.0
            if valley >= MERGE_VALLEY * min(peak, ppk):
                merged[-1] = (ps, e, max(peak, ppk))
                continue
        merged.append((s, e, peak))
    centers = [s + int(np.argmax(p_s[s:e])) for s, e, _pk in merged]
    n_lines = max(1, len(centers))
    seg.n_lines = n_lines
    # Per-line size = the median height of ONE line's inked core (a merged peak
    # region), NOT the block's total extent / line count. The latter includes
    # inter-line leading, so a 2-line heading would measure ~1.5x a 1-line heading
    # of the SAME font and get wrongly promoted (Adnan's bug via line count). Core
    # height is per-line, so a wrapped heading measures the same as a single-line
    # one of the same type; it is also length-invariant.
    seg._band_px = float(np.median([e - s for s, e, _pk in merged]))
    seg._pitch_px = float(np.median(np.diff(centers))) if len(centers) >= 2 else 0.0


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
        seg.ink_left = float(left)
        seg.ink_right = float(right)
        left_margin = left / page_width
        right_margin = (page_width - right) / page_width
        # centered: comparable margins on both sides and not spanning full width
        span = (right - left) / page_width
        seg.centered = bool(span < 0.85 and abs(left_margin - right_margin) < 0.08)
    rows = dark.any(axis=1)
    if rows.any():
        seg.bold = bool(float(dark[rows].mean()) > 0.30)
