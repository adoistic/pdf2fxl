from __future__ import annotations
from collections import defaultdict
from typing import Callable, Dict, List, Optional
import math
import re

from .segment import Segment, is_heading_type
from .inline_md import strip_inline_md

W0 = 6.0               # brevity knee: a 6-word heading has brevity penalty -1.0
MAX_LEVEL = 6


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


# --------------------------------------------------------------------------- #
# Robust stats + book-global size calibration
# --------------------------------------------------------------------------- #
def _median(vals: List[float]) -> float:
    v = sorted(vals)
    n = len(v)
    if n == 0:
        return 0.0
    m = n // 2
    return v[m] if n % 2 else (v[m - 1] + v[m]) / 2.0


def _mass_weighted_mode(vals: List[float], weights: List[float],
                        bin_px: float = 0.5) -> float:
    """The value carrying the most weight, binned — mirrors body_size's method."""
    mass: Dict[float, float] = defaultdict(float)
    for v, wt in zip(vals, weights):
        if v <= 0:
            continue
        mass[round(v / bin_px) * bin_px] += wt
    if not mass:
        return 0.0
    return max(mass.items(), key=lambda kv: kv[1])[0]


def body_line_size(segments: List[Segment], bin_px: float = 0.5) -> float:
    """Dominant body per-line size (char-mass weighted) using the content-invariant
    _band_px (ink extent / line count). The line_px analogue of body_size, measured
    the SAME way as headings so the ratio is meaningful. Returns 0.0 if none."""
    vals, wts = [], []
    for s in segments:
        if is_heading_type(s.type) or s.type in ("image", "table"):
            continue
        if s._band_px <= 0 or not s.text:
            continue
        vals.append(s._band_px); wts.append(len(s.text))
    return _mass_weighted_mode(vals, wts, bin_px)


def finalize_line_sizes(segments: List[Segment]) -> None:
    """Fill s.line_px (content-invariant per-line size) for every segment. This is
    the measured _band_px (inked vertical extent / peak-counted line count), which
    is invariant to line length and to how ascenders/descenders split a line, with
    a size_px fallback for degenerate blocks. Kept as a named pipeline step (called
    before assign_levels in build_doc) so the leveling reads a settled field."""
    for s in segments:
        s.line_px = s._band_px if s._band_px > 0 else s.size_px


# --------------------------------------------------------------------------- #
# Language-agnostic prominence features
# --------------------------------------------------------------------------- #
_CJK_RANGES = (
    (0x3040, 0x30FF),    # Hiragana + Katakana
    (0x3400, 0x4DBF),    # CJK Ext A
    (0x4E00, 0x9FFF),    # CJK Unified
    (0xF900, 0xFAFF),    # CJK Compatibility
    (0xAC00, 0xD7A3),    # Hangul syllables
    (0x20000, 0x2FA1F),  # CJK Ext B+ (supplementary)
)


def _is_cjk(ch: str) -> bool:
    o = ord(ch)
    return any(lo <= o <= hi for lo, hi in _CJK_RANGES)


def _verbosity(text: str) -> float:
    """Word-equivalent count, language-agnostic. Space-delimited scripts use word
    count; CJK (space-free) approximates words as ideographs * 0.5."""
    t = (text or "").strip()
    if not t:
        return 0.0
    cjk = sum(1 for c in t if _is_cjk(c))
    non_cjk = "".join(" " if _is_cjk(c) else c for c in t)
    words = len(non_cjk.split())
    if cjk == 0:
        return float(max(1, words))
    return float(max(1, words + math.ceil(cjk * 0.5)))


def _caps_frac(text: str, min_cased: int = 4) -> Optional[float]:
    """Uppercase fraction among cased letters, or None when the concept does not
    apply (caseless scripts: CJK/Arabic/Devanagari/Hebrew, or too few cased chars).
    Returning None (not 0.0) means the caps signal is OMITTED for that heading, so a
    uniform book-wide absence is a constant offset that cannot change ranks."""
    letters = [c for c in text if c.isalpha()]
    cased = [c for c in letters if c.islower() or c.isupper()]
    if len(cased) < min_cased:
        return None
    upper = sum(1 for c in cased if c.isupper())
    return upper / len(cased)


def _prominence(seg: Segment, body_line: float, col_w: float) -> float:
    """Holistic top-heading likelihood (higher = more top-level). Combines a
    content-invariant size ratio with penalties for verbosity/line-count/full-width
    span and bonuses for all-caps/centered/bold. Every term is signed so that
    'more prominent => larger'. Falls back to size_px when line_px is unset (so
    directly-constructed test segments without finalize_line_sizes still work)."""
    eff = seg.line_px if seg.line_px > 0 else seg.size_px
    r = eff / body_line if body_line > 0 else 1.0
    size_term = min(3.0, max(0.6, r))                       # clamp so one outlier can't dominate

    p = 1.4 * size_term
    p += -math.log2(1.0 + _verbosity(seg.text) / W0)        # verbosity penalty (grows slowly)
    p += -0.5 * max(0, seg.n_lines - 1)                     # each extra line costs 0.5

    if col_w and col_w > 0:
        span = (seg.ink_right - seg.ink_left) / col_w
        span = min(1.0, max(0.0, span))
        p += -1.2 * max(0.0, span - 0.75) / 0.25            # only the top quartile of span is penalised

    c = _caps_frac(seg.text)
    if c is not None:
        p += 0.6 * c                                        # all-caps bonus (omitted for caseless scripts)
    if seg.centered:
        p += 0.4
    if seg.bold:
        p += 0.3
    return p


def assign_levels(segments: List[Segment], body_px: Optional[float] = None,
                  col_w_of: Optional[Callable[[Segment], float]] = None,
                  max_level: int = 6) -> None:
    """Set .level (1..max_level) on every heading Segment, book-globally, from a
    holistic prominence score (content-invariant size + brevity/span/caps/centered/
    bold), not raw size alone. Numbering depth stays authoritative where present.
    Non-headings keep level 0.

    body_px : dominant body LINE size (from body_line_size). If None, computed here.
    col_w_of: optional callable seg -> column width (page px) for span. If None,
              span is neutral (0) for every heading and simply drops out."""
    heads = [s for s in segments if is_heading_type(s.type)]
    if not heads:
        return

    body_line = body_px if body_px is not None else body_line_size(segments)
    if body_line <= 0:
        # degenerate (heading-only doc): fall back to median heading size so the
        # size ratio is still meaningful.
        hv = [(s.line_px or s.size_px) for s in heads if (s.line_px or s.size_px) > 0]
        body_line = _median(hv) if hv else 1.0

    def col_w(s: Segment) -> float:
        return col_w_of(s) if col_w_of is not None else 0.0

    # Segment is a mutable (unhashable) dataclass, so key prominence by id().
    prom = {id(s): _prominence(s, body_line, col_w(s)) for s in heads}

    numbered = [(s, parse_numbering(strip_inline_md(s.text))) for s in heads]
    has_numbers = any(depth > 0 for _, depth in numbered)

    # 1-2 unnumbered headings can't be tiered; all top level.
    if not has_numbers and len(heads) <= 2:
        for s in heads:
            s.level = 1
        return

    if has_numbers:
        # Learn a prominence centroid per numbering depth from the NUMBERED heads.
        by_depth: Dict[int, List[float]] = defaultdict(list)
        for s, depth in numbered:
            if depth > 0:
                by_depth[depth].append(prom[id(s)])
        centroid = {d: _median(v) for d, v in by_depth.items() if v}
        # Recurrence-demotion: UNCHANGED intent. A recurring unnumbered heading
        # (per-chapter 'References') is one section repeated, not N chapters ->
        # demote to level 2. Language-agnostic: keyed on the text repeating.
        recur: Dict[str, int] = defaultdict(int)
        for s, depth in numbered:
            if depth == 0 and s.text:
                recur[strip_inline_md(s.text).strip().lower()] += 1
        demote = min(2, max_level)
        for s, depth in numbered:
            if depth > 0:
                s.level = min(depth, max_level)
            elif recur[strip_inline_md(s.text).strip().lower()] >= 3:
                s.level = demote
            elif centroid:
                nearest = min(centroid, key=lambda d: abs(centroid[d] - prom[id(s)]))
                s.level = min(nearest, max_level)
            else:
                s.level = 1
        return

    # No numbering anywhere: tier by ROBUST size (relative gaps on line_px), which
    # gives a clean size hierarchy now that line_px is content-invariant. Then apply
    # a CONSERVATIVE demotion: a block that fills the full measure, wraps to 2+
    # lines, AND is far wordier than its peer headings reads like body, so it drops
    # one tier — this is exactly the "long heading wrongly promoted" case. Robust
    # measurement already stops length from inflating size; this only catches the
    # residual paragraph-masquerading-as-heading.
    def _eff(s: Segment) -> float:
        return s.line_px if s.line_px > 0 else s.size_px

    tiers = _tier_levels([_eff(s) for s in heads])
    med_vb = _median([_verbosity(s.text) for s in heads]) or 1.0
    for s in heads:
        lvl = min(tiers.get(_eff(s), 1), max_level)
        span = (s.ink_right - s.ink_left) / col_w(s) if col_w(s) > 0 else 0.0
        body_like = span >= 0.85 and s.n_lines >= 2 and _verbosity(s.text) >= 2.5 * med_vb
        if body_like and lvl < max_level:
            lvl += 1
        s.level = lvl
    # Largest-type guard: a genuinely big title (even a long, full-width one) must
    # never be demoted. Any heading at the global-max robust size is floored to 1.
    max_eff = max((_eff(s) for s in heads), default=0.0)
    if max_eff > 0:
        for s in heads:
            if abs(_eff(s) - max_eff) <= 1e-6:
                s.level = 1
