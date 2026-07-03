"""Deterministic fit-to-box font sizing.

Instead of estimating font size from glyph pixel heights (fragile), solve for it:
binary-search the largest integer pixel size whose greedy word-wrapped layout —
measured with the *same TTF that the renderers embed* — fits inside the block's
box. The returned size always satisfies the measured-fit check, so text cannot
overflow its box in any renderer that honours font-size + line-height.

Both renderers must use ``LINE_SPACING`` for this guarantee to hold
(CSS ``line-height`` in the EPUB, paragraph ``line_spacing`` in the PPTX).
"""
from __future__ import annotations
from functools import lru_cache
from typing import List, Optional

from PIL import ImageFont

LINE_SPACING = 1.2   # shared by fit math, EPUB CSS, and PPTX paragraphs
SAFETY = 0.96        # measure against a slightly shrunken box to absorb
                     # renderer-to-renderer metric differences
MIN_PX = 8


@lru_cache(maxsize=256)
def _font(font_path: str, px: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(font_path, px)


def wrapped_line_widths(text: str, px: int, max_w: float,
                        font_path: str) -> Optional[List[float]]:
    """Greedy word-wrap `text` at size `px`; return each line's measured width.

    Returns None if any single word is wider than `max_w` (i.e. this size
    cannot fit at all).
    """
    font = _font(font_path, px)
    space_w = font.getlength(" ")
    lines: List[float] = []
    cur = 0.0
    words_on_line = 0
    for word in text.split():
        w = font.getlength(word)
        if w > max_w:
            return None
        candidate = w if words_on_line == 0 else cur + space_w + w
        if candidate <= max_w:
            cur = candidate
            words_on_line += 1
        else:
            lines.append(cur)
            cur = w
            words_on_line = 1
    if words_on_line:
        lines.append(cur)
    return lines


def fit_font_px(text: str, box_w: float, box_h: float, font_path: str,
                line_spacing: float = LINE_SPACING, safety: float = SAFETY,
                min_px: int = MIN_PX) -> float:
    """Largest integer px size whose wrapped layout fits the box; >= min_px.

    The fit predicate is monotone for practical text (larger type -> more lines
    -> taller), so binary search applies; the returned size is verified against
    the predicate, which is the actual guarantee.
    """
    text = " ".join(text.split())
    if not text or box_w <= 0 or box_h <= 0:
        return float(min_px)
    max_w = box_w * safety
    max_h = box_h * safety

    def fits(px: int) -> bool:
        lines = wrapped_line_widths(text, px, max_w, font_path)
        return lines is not None and len(lines) * px * line_spacing <= max_h

    hi = max(int(max_h / line_spacing), min_px)   # single line filling the box
    lo = min_px
    if not fits(lo):
        return float(min_px)      # pathological box; clamp (may overflow)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if fits(mid):
            lo = mid
        else:
            hi = mid - 1
    return float(lo)
