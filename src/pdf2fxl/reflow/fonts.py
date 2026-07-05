"""Resolve and cache the Noto webfonts a book needs, by detected script.

Fonts come from the Google Fonts CSS2 API (per-subset woff2 with unicode-range), so
any script Google publishes is reachable with no bundled files. Downloads are cached
under the user cache dir; a Latin-only book triggers no network at all. Any failure
degrades gracefully: the face is skipped and the bundled base font still renders.
"""
from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple
import hashlib
import re
import urllib.parse
import urllib.request

from . import scripts as _scripts

_CACHE = Path.home() / ".cache" / "pdf2fxl" / "fonts"
_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
       "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36")
_BLOCK = re.compile(
    r"/\*\s*(?P<subset>[\w-]+)\s*\*/\s*@font-face\s*\{(?P<body>[^}]*)\}", re.S)


@dataclass
class FontFace:
    family: str
    weight: int
    unicode_range: str
    path: Path           # local woff2 on disk
    subset: str


def _get(url: str, timeout: int = 20) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _css2(family: str, weights: str = "wght@400;700") -> Optional[str]:
    """Google Fonts CSS2 for `family`; retry without weights, return None on failure."""
    base = "https://fonts.googleapis.com/css2?family="
    fam = urllib.parse.quote(family)
    for q in (f"{base}{fam}:{weights}&display=swap", f"{base}{fam}&display=swap"):
        try:
            return _get(q).decode("utf-8")
        except Exception:
            continue
    return None


def _parse(css: str, family: str) -> List[Tuple[str, int, str, str]]:
    """-> list of (subset, weight, woff2_url, unicode_range)."""
    out: List[Tuple[str, int, str, str]] = []
    for m in _BLOCK.finditer(css):
        body = m.group("body")
        url = re.search(r"src:\s*url\((https://[^)]+\.woff2)\)", body)
        if not url:
            continue
        w = re.search(r"font-weight:\s*(\d+)", body)
        ur = re.search(r"unicode-range:\s*([^;]+);", body)
        out.append((m.group("subset"), int(w.group(1)) if w else 400,
                    url.group(1), (ur.group(1).strip() if ur else "")))
    return out


def _cache_path(family: str, weight: int, subset: str, url: str) -> Path:
    key = hashlib.sha1(f"{family}|{weight}|{subset}|{url}".encode()).hexdigest()[:12]
    safe = re.sub(r"[^A-Za-z0-9]+", "", family)
    return _CACHE / f"{safe}-{subset}-{weight}-{key}.woff2"


def _download(url: str, dest: Path) -> bool:
    if dest.exists() and dest.stat().st_size > 0:
        return True
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        data = _get(url)
        if data[:4] != b"wOF2":
            return False
        dest.write_bytes(data)
        return True
    except Exception:
        return False


def _faces_for(family: str, subset: str, cache_dir: Path) -> List[FontFace]:
    """Fetch `family`, keep the blocks for `subset` (or all if none match), download."""
    css = _css2(family)
    if css is None and " Serif" in family:              # Serif -> Sans fallback
        family = family.replace(" Serif", " Sans")
        css = _css2(family)
    if css is None:
        return []
    blocks = _parse(css, family)
    chosen = [b for b in blocks if b[0] == subset]
    if not chosen:                                       # subset name mismatch (e.g. CJK)
        chosen = blocks
    faces: List[FontFace] = []
    for sub, weight, url, urange in chosen:
        dest = _cache_path(family, weight, sub, url)
        if _download(url, dest):
            faces.append(FontFace(family=family, weight=weight,
                                  unicode_range=urange, path=dest, subset=sub))
    return faces


def resolve_fonts(script_set: Set[str],
                  cache_dir: Optional[Path] = None) -> List[FontFace]:
    """Embeddable faces for every non-Latin script in `script_set` (deduped)."""
    cache_dir = Path(cache_dir) if cache_dir else _CACHE
    wanted: List[Tuple[str, str]] = []
    seen_spec = set()
    for s in sorted(script_set):
        spec = _scripts.font_for(s)
        if spec[0] == "Noto Serif":            # Latin base handles these already
            continue
        if spec not in seen_spec:
            seen_spec.add(spec)
            wanted.append(spec)
    faces: List[FontFace] = []
    seen_face = set()
    for family, subset in wanted:
        for face in _faces_for(family, subset, cache_dir):
            key = (face.family, face.weight, face.subset)
            if key not in seen_face:
                seen_face.add(key)
                faces.append(face)
    return faces


def family_stack(faces: List[FontFace], base_family: str) -> List[str]:
    """Ordered, deduped font-family stack: base first, then each script family."""
    stack = [base_family]
    for f in faces:
        if f.family not in stack:
            stack.append(f.family)
    return stack
