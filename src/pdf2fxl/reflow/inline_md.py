"""Inline markdown emphasis -> styled runs.

Mistral OCR emits block text with inline **bold** / __bold__ / *italic* / _italic_.
The reflow renderer html-escapes run text, so those markers would print literally.
This module turns matched emphasis pairs into styled Runs (markers removed), and
leaves anything ambiguous verbatim: unbalanced markers, snake_case underscores,
arithmetic like a*b or 3*4*5, and runs of >=3 markers all stay literal.

A two-phase scanner (CommonMark-style flanking rules), not a regex, so balancing,
nesting, and false positives are decided deterministically.
"""
from __future__ import annotations
from typing import List, Optional, Tuple
import unicodedata

from .docmodel import Run

_MARKERS = ("*", "_")


def _is_ws(ch: Optional[str]) -> bool:
    return ch is None or ch.isspace()


def _is_punct(ch: Optional[str]) -> bool:
    if ch is None:
        return True
    if ch in _MARKERS:
        return True
    return unicodedata.category(ch).startswith("P")


def _math_only(interior: str) -> bool:
    """True if interior is digits/operators/space only (no letters). Guards tight
    arithmetic like 3*4*5 from being italicised, while *word* still italicises."""
    if not interior:
        return True
    for c in interior:
        if c.isalpha():
            return False
        if not (c.isdigit() or c.isspace() or c in "+-×·./^=()%,"):
            return False
    return True


class _Delim:
    __slots__ = ("pos", "length", "char", "can_open", "can_close")

    def __init__(self, pos, length, char, can_open, can_close):
        self.pos = pos; self.length = length; self.char = char
        self.can_open = can_open; self.can_close = can_close


def _scan_delims(text: str) -> Tuple[List, List[_Delim]]:
    """Return (tokens, delims). A run of 1 or 2 identical markers is a delimiter
    candidate; runs of length >=3 are literal text (out of scope: Mistral emits
    only ** and *). Flanking decides open/close eligibility."""
    tokens: List = []
    delims: List[_Delim] = []
    n = len(text)
    i = 0
    lit_start = 0
    while i < n:
        c = text[i]
        if c not in _MARKERS:
            i += 1
            continue
        j = i
        while j < n and text[j] == c:
            j += 1
        run_len = j - i
        if run_len >= 3:
            i = j                                   # literal, keep scanning
            continue
        # flush literal text before this delimiter
        if i > lit_start:
            tokens.append(("text", lit_start, i))
        prev = text[i - 1] if i > 0 else None
        nxt = text[j] if j < n else None
        left_flank = (not _is_ws(nxt)) and (
            (not _is_punct(nxt)) or _is_ws(prev) or _is_punct(prev))
        right_flank = (not _is_ws(prev)) and (
            (not _is_punct(prev)) or _is_ws(nxt) or _is_punct(nxt))
        if c == "_":
            # intraword underscore rule: an underscore between alphanumerics
            # (snake_case, C_2H_5) is neither opener nor closer.
            can_open = left_flank and (not right_flank or _is_punct(prev))
            can_close = right_flank and (not left_flank or _is_punct(nxt))
        else:
            can_open = left_flank
            can_close = right_flank
        delims.append(_Delim(i, run_len, c, can_open, can_close))
        tokens.append(("delim", len(delims) - 1))
        i = j
        lit_start = j
    if n > lit_start:
        tokens.append(("text", lit_start, n))
    return tokens, delims


def _match_pairs(delims: List[_Delim], text: str):
    """Match openers/closers of equal char and equal length via a stack. Returns
    dict: delim_index -> (partner_index, style) for MATCHED delimiters only, where
    style is 'b' (len 2) or 'i' (len 1). Unmatched delimiters are absent (literal)."""
    matched = {}
    stack: List[int] = []
    for idx, d in enumerate(delims):
        if d.can_close and stack:
            found = None
            for k in range(len(stack) - 1, -1, -1):
                o = delims[stack[k]]
                if o.char == d.char and o.length == d.length and o.can_open:
                    found = k
                    break
            if found is not None:
                opener_idx = stack[found]
                opener = delims[opener_idx]
                interior = text[opener.pos + opener.length:d.pos]
                # reject empty emphasis (**** -> literal) and tight-math single-*
                if interior == "" or (opener.length == 1 and opener.char == "*"
                                      and _math_only(interior)):
                    if d.can_open:
                        stack = stack[:found]      # discard skipped, keep this as opener
                        stack.append(idx)
                    else:
                        stack = stack[:found]
                    continue
                style = "b" if opener.length == 2 else "i"
                matched[opener_idx] = (idx, style)
                matched[idx] = (opener_idx, style)
                del stack[found:]                  # unmatched openers above become literal
                continue
        if d.can_open:
            stack.append(idx)
        # else: literal (neither matched nor pushed)
    return matched


def parse_inline_md(text: str, base_bold: bool = False) -> List[Run]:
    """Parse inline **bold** / __bold__ / *italic* / _italic_ into styled Runs with
    the emphasis markers of MATCHED pairs removed. Unmatched/unbalanced markers,
    snake_case underscores, spaced or tight arithmetic, and runs of >=3 markers stay
    literal. base_bold (the block-level ink-density bold flag) ORs into every run."""
    if not text:
        return []
    tokens, delims = _scan_delims(text)
    matched = _match_pairs(delims, text)

    # Build per-character (bold, italic) style over the ORIGINAL string, and mark
    # which characters are consumed markers (to be dropped from output).
    n = len(text)
    bold = [base_bold] * n
    ital = [False] * n
    drop = [False] * n

    # Walk matched pairs, applying style to the interior and dropping the markers.
    for idx, (partner, style) in matched.items():
        d = delims[idx]
        for k in range(d.pos, d.pos + d.length):
            drop[k] = True                          # marker chars removed
        if idx < partner:                           # opener drives interior styling
            interior_start = d.pos + d.length
            interior_end = delims[partner].pos
            for k in range(interior_start, interior_end):
                if style == "b":
                    bold[k] = True
                else:
                    ital[k] = True

    # Emit: coalesce maximal runs of equal (bold, italic) over non-dropped chars.
    runs: List[Run] = []
    buf = []
    cur = None
    for k in range(n):
        if drop[k]:
            continue
        key = (bold[k], ital[k])
        if cur is None:
            cur = key
        if key != cur:
            runs.append(Run(text="".join(buf), bold=cur[0], italic=cur[1]))
            buf = []
            cur = key
        buf.append(text[k])
    if buf:
        runs.append(Run(text="".join(buf), bold=cur[0], italic=cur[1]))
    return runs


def strip_inline_md(text: str) -> str:
    """Plain text with matched inline-emphasis markers removed. Reuses the exact
    tokenizer so a heading and a paragraph never disagree on what a delimiter is.
    Unmatched markers and snake_case underscores are preserved verbatim."""
    return "".join(r.text for r in parse_inline_md(text, base_bold=False))
