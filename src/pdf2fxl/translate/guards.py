"""Always-on script-integrity checks over translation output.

Deterministic implementations of the corpus's guards/script-integrity.md:
(a) Urdu output must contain zero Devanagari, (b) numerals must survive by
count and value, (c) markdown structure must survive by element type/count.

Severity: (a) and (c) are hard failures (the translation is refused after one
retry). (b) is soft: it feeds the retry, but a persistent mismatch is reported
as a note rather than refusing the job, because many languages legitimately
spell out small numbers and a hard fail would burn good translations.
"""
from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field
from typing import List

_DEVANAGARI = re.compile("[\\u0900-\\u097f]")
_ARABIC_SCRIPT = re.compile("[\\u0600-\\u06ff\\u0750-\\u077f]")
_NUMERAL = re.compile(r"\d+(?:[,.]\d+)*")

_HEADING = re.compile(r"^(#{1,6})\s", re.MULTILINE)
_FENCE = re.compile(r"^```", re.MULTILINE)
_LIST_ITEM = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+\S", re.MULTILINE)
_BLOCKQUOTE = re.compile(r"^\s*>", re.MULTILINE)
_LINK_URL = re.compile(r"\]\(([^)\s]+)(?:\s[^)]*)?\)")
_IMAGE = re.compile(r"!\[")
_TABLE_SEP = re.compile(r"^\s*\|?[\s:|-]*-{3,}[\s:|-]*\|", re.MULTILINE)


@dataclass
class GuardReport:
    hard: List[str] = field(default_factory=list)   # refuse after retry
    soft: List[str] = field(default_factory=list)   # retry once, then note

    @property
    def issues(self) -> List[str]:
        return self.hard + self.soft

    @property
    def passed(self) -> bool:
        return not self.hard


def check_target_script(target_language: str, output: str) -> List[str]:
    """(a) Urdu output: zero tolerance for Devanagari, and Urdu script must
    actually be present."""
    if "urdu" not in target_language.lower():
        return []
    issues = []
    leak = _DEVANAGARI.search(output)
    if leak:
        issues.append(
            f"wrong_script: Devanagari character {leak.group(0)!r} in Urdu output"
        )
    if not _ARABIC_SCRIPT.search(output):
        issues.append("wrong_script: Urdu output contains no Urdu script")
    return issues


def check_numerals(source: str, output: str) -> List[str]:
    """(b) Every Arabic numeral in the source must appear unchanged in the
    output, by value and count. Roman numerals are skipped: across languages
    they collide with real words ("I", "C") and false-fail good output."""
    src = Counter(_NUMERAL.findall(source))
    out = Counter(_NUMERAL.findall(output))
    missing = src - out
    if not missing:
        return []
    shown = ", ".join(sorted(missing)[:8])
    return [f"numerals: source numerals missing or altered in output: {shown}"]


def _structure_counts(text: str) -> dict:
    heading_levels = Counter(len(m.group(1)) for m in _HEADING.finditer(text))
    return {
        "fences": len(_FENCE.findall(text)),
        "list_items": len(_LIST_ITEM.findall(text)),
        "blockquote_lines": len(_BLOCKQUOTE.findall(text)),
        "images": len(_IMAGE.findall(text)),
        "table_seps": len(_TABLE_SEP.findall(text)),
        **{f"h{lvl}": n for lvl, n in heading_levels.items()},
    }


def check_markdown_structure(source: str, output: str) -> List[str]:
    """(c) Markdown structure must survive: per-type element counts must not
    shrink, and every source URL must appear byte-exact in the output."""
    issues: List[str] = []
    src, out = _structure_counts(source), _structure_counts(output)
    for key, n in src.items():
        if out.get(key, 0) < n:
            issues.append(
                f"markdown: {key} count fell from {n} to {out.get(key, 0)}"
            )
    src_urls = set(_LINK_URL.findall(source))
    out_urls = set(_LINK_URL.findall(output))
    for url in sorted(src_urls - out_urls)[:8]:
        issues.append(f"markdown: link url changed or lost: {url}")
    return issues


def check_emphasis(source: str, output: str) -> List[str]:
    """Soft check: inline emphasis pairs should survive. Merged or re-worded
    emphasis is tolerable (soft), unlike lost headings/tables (hard)."""
    issues = []
    for marker, name in (("**", "bold"), ("*", "italic")):
        src_n = source.count(marker) // 2
        out_n = output.count(marker) // 2
        if out_n < src_n:
            issues.append(f"markdown: {name} span count fell from {src_n} to {out_n}")
    return issues


def run_guards(target_language: str, source: str, output: str) -> GuardReport:
    report = GuardReport()
    report.hard += check_target_script(target_language, output)
    report.hard += check_markdown_structure(source, output)
    report.soft += check_numerals(source, output)
    report.soft += check_emphasis(source, output)
    return report
