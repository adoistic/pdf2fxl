"""Detect which writing systems a book uses, and map each to a Google (Noto) font.

The reflow renderer embeds the bundled Noto Serif for Latin/Greek/Cyrillic and adds
one Noto face per *other* script present, so every script gets the right glyphs with
no user choice. Detection is by Unicode block; font assignment is a fixed table.
"""
from __future__ import annotations
from collections import Counter
from typing import Dict, List, Set, Tuple

# script -> list of (inclusive) codepoint ranges that identify it
_RANGES: List[Tuple[str, List[Tuple[int, int]]]] = [
    ("Devanagari", [(0x0900, 0x097F), (0xA8E0, 0xA8FF)]),
    ("Bengali",    [(0x0980, 0x09FF)]),
    ("Gurmukhi",   [(0x0A00, 0x0A7F)]),
    ("Gujarati",   [(0x0A80, 0x0AFF)]),
    ("Oriya",      [(0x0B00, 0x0B7F)]),
    ("Tamil",      [(0x0B80, 0x0BFF)]),
    ("Telugu",     [(0x0C00, 0x0C7F)]),
    ("Kannada",    [(0x0C80, 0x0CFF)]),
    ("Malayalam",  [(0x0D00, 0x0D7F)]),
    ("Sinhala",    [(0x0D80, 0x0DFF)]),
    ("Thai",       [(0x0E00, 0x0E7F)]),
    ("Lao",        [(0x0E80, 0x0EFF)]),
    ("Tibetan",    [(0x0F00, 0x0FFF)]),
    ("Myanmar",    [(0x1000, 0x109F)]),
    ("Georgian",   [(0x10A0, 0x10FF), (0x1C90, 0x1CBF)]),
    ("Ethiopic",   [(0x1200, 0x137F)]),
    ("Khmer",      [(0x1780, 0x17FF)]),
    ("Armenian",   [(0x0530, 0x058F)]),
    ("Hebrew",     [(0x0590, 0x05FF)]),
    ("Arabic",     [(0x0600, 0x06FF), (0x0750, 0x077F), (0x08A0, 0x08FF),
                    (0xFB50, 0xFDFF), (0xFE70, 0xFEFF)]),
    ("Hangul",     [(0xAC00, 0xD7A3), (0x1100, 0x11FF), (0x3130, 0x318F)]),
    ("Hiragana",   [(0x3040, 0x309F)]),
    ("Katakana",   [(0x30A0, 0x30FF)]),
    ("Han",        [(0x4E00, 0x9FFF), (0x3400, 0x4DBF), (0xF900, 0xFAFF)]),
    # Latin / Greek / Cyrillic are covered by the bundled base face, not listed here.
]

# script -> (Google font family, the Google subset name that carries it).
# If a family/subset is unavailable, fonts.py falls back (Serif->Sans, then all subsets).
_FONT: Dict[str, Tuple[str, str]] = {
    "Devanagari": ("Noto Serif Devanagari", "devanagari"),
    "Bengali":    ("Noto Serif Bengali", "bengali"),
    "Gurmukhi":   ("Noto Serif Gurmukhi", "gurmukhi"),
    "Gujarati":   ("Noto Serif Gujarati", "gujarati"),
    "Oriya":      ("Noto Sans Oriya", "oriya"),
    "Tamil":      ("Noto Serif Tamil", "tamil"),
    "Telugu":     ("Noto Serif Telugu", "telugu"),
    "Kannada":    ("Noto Serif Kannada", "kannada"),
    "Malayalam":  ("Noto Serif Malayalam", "malayalam"),
    "Sinhala":    ("Noto Serif Sinhala", "sinhala"),
    "Thai":       ("Noto Serif Thai", "thai"),
    "Lao":        ("Noto Serif Lao", "lao"),
    "Tibetan":    ("Noto Serif Tibetan", "tibetan"),
    "Myanmar":    ("Noto Sans Myanmar", "myanmar"),
    "Georgian":   ("Noto Serif Georgian", "georgian"),
    "Ethiopic":   ("Noto Serif Ethiopic", "ethiopic"),
    "Khmer":      ("Noto Serif Khmer", "khmer"),
    "Armenian":   ("Noto Serif Armenian", "armenian"),
    "Hebrew":     ("Noto Serif Hebrew", "hebrew"),
    "Arabic":     ("Noto Naskh Arabic", "arabic"),
    "Hangul":     ("Noto Serif KR", "korean"),
    "Hiragana":   ("Noto Serif JP", "japanese"),
    "Katakana":   ("Noto Serif JP", "japanese"),
    "Han":        ("Noto Serif SC", "chinese-simplified"),
}

# best-effort BCP47 language tag for dc:language, by dominant non-Latin script
_LANG: Dict[str, str] = {
    "Devanagari": "hi", "Bengali": "bn", "Gurmukhi": "pa", "Gujarati": "gu",
    "Oriya": "or", "Tamil": "ta", "Telugu": "te", "Kannada": "kn",
    "Malayalam": "ml", "Sinhala": "si", "Thai": "th", "Lao": "lo",
    "Tibetan": "bo", "Myanmar": "my", "Georgian": "ka", "Ethiopic": "am",
    "Khmer": "km", "Armenian": "hy", "Hebrew": "he", "Arabic": "ar",
    "Hangul": "ko", "Hiragana": "ja", "Katakana": "ja", "Han": "zh",
}


def _script_of(cp: int) -> str:
    for name, ranges in _RANGES:
        for lo, hi in ranges:
            if lo <= cp <= hi:
                return name
    return ""


def script_counts(text: str) -> Counter:
    """Count characters per detected (non-Latin) script in `text`."""
    c: Counter = Counter()
    for ch in text:
        name = _script_of(ord(ch))
        if name:
            c[name] += 1
    return c


def detect_scripts(text: str, min_chars: int = 3) -> Set[str]:
    """Scripts (beyond Latin/Greek/Cyrillic) present with at least `min_chars`."""
    return {s for s, n in script_counts(text).items() if n >= min_chars}


def font_for(script: str) -> Tuple[str, str]:
    """(Google family, subset) for a detected script."""
    return _FONT.get(script, ("Noto Serif", "latin"))


def language_for(scripts: Set[str], counts: Counter, default: str = "en") -> str:
    """Pick a dc:language tag from the dominant non-Latin script, else `default`."""
    if not scripts:
        return default
    dominant = max(scripts, key=lambda s: counts.get(s, 0))
    return _LANG.get(dominant, default)
