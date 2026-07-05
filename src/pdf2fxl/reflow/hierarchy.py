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
