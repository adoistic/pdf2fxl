"""Corpus loader: progressive disclosure over the vendored translation corpus.

Mirrors the corpus's own routing rules: load the one stance file that matches,
the one category guidance file (or none), the grammar file for the target
language when one exists, the colloquial-register row for South Asian targets,
and the Urdu script rules when the target is Urdu. The stance and guidance
mappings are parsed from the taxonomy markdown itself, so the corpus stays the
single source of truth.
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Dict, List, Optional

_ROOT = Path(__file__).resolve().parent / "corpus"


def load(relpath: str) -> str:
    return (_ROOT / relpath).read_text(encoding="utf-8")


def has(relpath: str) -> bool:
    return (_ROOT / relpath).is_file()


def _norm_lang(language: str) -> str:
    """Lowercased language name with any parenthetical qualifier removed,
    e.g. "Manipuri (Meitei)" -> "manipuri"."""
    base = language.split("(")[0]
    return " ".join(base.strip().lower().split())


# --------------------------------------------------------------------------- #
# Taxonomy tables (stance + guidance per category)
# --------------------------------------------------------------------------- #
def _table_rows(text: str, heading: str) -> List[List[str]]:
    """The body rows of the first markdown table under `heading`."""
    rows: List[List[str]] = []
    in_section = False
    for line in text.splitlines():
        if line.startswith("## "):
            in_section = line[3:].strip().lower() == heading.lower()
            continue
        if not in_section or not line.strip().startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if not cells or set(cells[0]) <= {"-", ":", " "}:
            continue  # separator row
        rows.append(cells)
    return rows


@lru_cache(maxsize=1)
def taxonomy() -> str:
    return load("content-types/taxonomy.md")


@lru_cache(maxsize=1)
def _stance_map() -> Dict[str, str]:
    rows = _table_rows(taxonomy(), "Stance mapping")
    return {r[0].lower(): r[1].lower() for r in rows[1:] if len(r) >= 2}


@lru_cache(maxsize=1)
def _guidance_map() -> Dict[str, Optional[str]]:
    out: Dict[str, Optional[str]] = {}
    rows = _table_rows(taxonomy(), "Category guidance files")
    for r in rows[1:]:
        if len(r) < 2:
            continue
        path = r[1]
        out[r[0].lower()] = None if "none" in path.lower() else path.split("(")[0].strip()
    return out


def categories() -> List[str]:
    return [c.title() if c.islower() else c for c in _stance_map().keys()]


def stance_for_category(category: str) -> str:
    """literary | commercial; unknown categories fall back to commercial
    (the taxonomy's own default for "Other")."""
    return _stance_map().get(category.strip().lower(), "commercial")


def guidance_for_category(category: str) -> Optional[str]:
    """The one guidance file's text for a category, or None."""
    rel = _guidance_map().get(category.strip().lower())
    if not rel or not has(rel):
        return None
    return load(rel)


def stance_text(stance: str) -> str:
    name = "literary" if stance.strip().lower() == "literary" else "commercial"
    return load(f"stances/{name}.md")


# --------------------------------------------------------------------------- #
# Per-language files
# --------------------------------------------------------------------------- #
def grammar_for(language: str) -> Optional[str]:
    rel = f"languages/grammar/{_norm_lang(language)}-grammar.md"
    return load(rel) if has(rel) else None


def script_rules_for(language: str) -> Optional[str]:
    if "urdu" in _norm_lang(language):
        return load("languages/script-rules/urdu.md")
    return None


@lru_cache(maxsize=1)
def _colloquial_map() -> Dict[str, str]:
    # The map's table is not under its own H2, so scan the whole file.
    rows: List[List[str]] = []
    for line in load("languages/colloquial-map.md").splitlines():
        if not line.strip().startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) >= 2 and not set(cells[0]) <= {"-", ":", " "}:
            rows.append(cells)
    return {
        r[0].lower(): r[1]
        for r in rows
        if len(r) >= 2 and r[0].lower() not in ("user language",)
    }


def colloquial_render_as(language: str) -> Optional[str]:
    """The colloquial "Render as" instruction for a South Asian target, or None.
    Stance-awareness (commercial only by default) is the caller's concern."""
    return _colloquial_map().get(_norm_lang(language))


def script_integrity_guard() -> str:
    return load("guards/script-integrity.md")
