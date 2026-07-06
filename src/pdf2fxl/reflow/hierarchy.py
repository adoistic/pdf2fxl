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
# Structural dividers: "Part 2", "Part II", "Book 3", "Volume IV". Recognised as
# top level so every "Part N" gets the same level, rather than each being tiered
# by noisy size measurement (which made Part 2 an H1 but Parts 1 and 3 H2s).
_PART = re.compile(r"^\s*(?:part|book|volume)\s+(?:\d+|[ivxlcdm]+)\b", re.IGNORECASE)


def parse_numbering(text: str) -> int:
    """Heading level implied by a leading section number, or 0 if none.
    Dotted decimals give depth (1 -> 1, 1.2 -> 2, 1.2.1 -> 3); Roman numerals,
    'Chapter N', 'Part/Book/Volume N', and Devanagari numerals are top level (1)."""
    if not text:
        return 0
    m = _DEC.match(text)
    if m:
        return m.group(1).count(".") + 1
    if (_ROMAN.match(text) or _CHAPTER.match(text) or _DEVA_NUM.match(text)
            or _PART.match(text)):
        return 1
    return 0


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
        # A recurring unnumbered heading (e.g. a per-chapter "References") printed
        # at chapter size would otherwise be promoted to top level once per
        # chapter. It is a section inside each chapter, not N chapters, so demote
        # any unnumbered text that recurs at least 3 times to just below the
        # chapter tier. Language-agnostic: keyed on the text repeating, not on a
        # word list.
        recur: Dict[str, int] = defaultdict(int)
        for s, depth in numbered:
            if depth == 0 and s.text:
                recur[s.text.strip().lower()] += 1
        demote = min(2, max_level)
        for s, depth in numbered:
            if depth > 0:
                s.level = min(depth, max_level)
            elif recur[s.text.strip().lower()] >= 3:
                s.level = demote
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
