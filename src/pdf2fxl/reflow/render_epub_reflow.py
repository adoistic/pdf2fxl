from __future__ import annotations
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Tuple
import html
import uuid
import zipfile

from ..fittext import font_family
from .docmodel import (Doc, Heading, Paragraph, Figure, Table, Formula, ChapterBreak)

CONTAINER_XML = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf"
     media-type="application/oebps-package+xml"/></rootfiles>
</container>
"""


def _css(base_file: str, base_family: str, faces, stack) -> str:
    """CSS binding the bundled base face plus one @font-face per script webface,
    with a font-family stack so each script's codepoints route to its font."""
    lines = [f'@font-face {{ font-family: "{base_family}"; src: url("fonts/{base_file}"); }}']
    for family, fname, weight, urange in faces:
        ur = f" unicode-range: {urange};" if urange else ""
        lines.append(
            f'@font-face {{ font-family: "{family}"; font-weight: {weight}; '
            f'src: url("fonts/{fname}") format("woff2");{ur} }}')
    stack_css = ", ".join(f'"{s}"' for s in stack) + ", serif"
    lines += [
        f"html, body {{ font-family: {stack_css}; line-height: 1.5; margin: 1em; }}",
        "p { margin: 0 0 0.8em; }",
        # A clear, decreasing heading ladder so the recovered levels are visible
        # (readers otherwise render h1..h6 nearly alike). Size steps down, and
        # weight plus top margin reinforce the hierarchy.
        "h1, h2, h3, h4, h5, h6 { line-height: 1.2; font-weight: 700; }",
        "h1 { font-size: 2em;    margin: 1.2em 0 0.6em; }",
        "h2 { font-size: 1.5em;  margin: 1.1em 0 0.5em; }",
        "h3 { font-size: 1.25em; margin: 1em 0 0.4em; }",
        "h4 { font-size: 1.1em;  margin: 1em 0 0.4em; }",
        "h5 { font-size: 1em;    margin: 1em 0 0.3em; }",
        "h6 { font-size: 0.9em;  margin: 1em 0 0.3em; font-weight: 600; }",
        "figure { margin: 1em 0; text-align: center; }",
        "img { max-width: 100%; height: auto; }",
        "figcaption { font-size: 0.9em; color: #444; }",
        # Tables: real borders and padding so an HTML table reads as a table.
        "table { border-collapse: collapse; margin: 1em auto; max-width: 100%; }",
        "th, td { border: 1px solid #999; padding: 0.35em 0.6em; text-align: left; "
        "vertical-align: top; }",
        "th { background: #f0ece4; font-weight: 700; }",
        "caption { font-size: 0.9em; color: #444; caption-side: bottom; padding-top: 0.4em; }",
    ]
    return "\n".join(lines) + "\n"


def _runs_html(runs) -> str:
    out = []
    for r in runs:
        t = html.escape(r.text)
        if r.bold:
            t = f"<strong>{t}</strong>"
        if r.italic:
            t = f"<em>{t}</em>"
        out.append(t)
    return "".join(out)


def _node_html(n) -> str:
    if isinstance(n, Heading):
        lvl = min(6, max(1, n.level))
        return f"<h{lvl}>{html.escape(n.text)}</h{lvl}>"
    if isinstance(n, Paragraph):
        return f"<p>{_runs_html(n.runs)}</p>"
    if isinstance(n, Figure):
        cap = f"<figcaption>{html.escape(n.caption)}</figcaption>" if n.caption else ""
        return (f'<figure><img src="{html.escape(n.src)}" '
                f'style="width:{n.width_frac * 100:.1f}%" alt=""/>{cap}</figure>')
    if isinstance(n, Table):
        if n.image_src:
            return f'<figure><img src="{html.escape(n.image_src)}" alt=""/></figure>'
        return n.html or ""
    if isinstance(n, Formula):
        if n.mathml:
            return n.mathml
        if n.image_src:
            return f'<figure><img src="{html.escape(n.image_src)}" alt=""/></figure>'
        return f"<p>{html.escape(n.text or '')}</p>"
    return ""


def _split_chapters(nodes) -> List[List]:
    chapters: List[List] = []
    cur: List = []
    for n in nodes:
        if isinstance(n, ChapterBreak):
            if cur:
                chapters.append(cur)
            cur = []
        else:
            cur.append(n)
    if cur:
        chapters.append(cur)
    return chapters or [[]]


def _chapter_xhtml(nodes, title: str) -> str:
    body = "\n".join(_node_html(n) for n in nodes)
    return f"""<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><meta charset="utf-8"/><title>{html.escape(title)}</title>
<link rel="stylesheet" type="text/css" href="styles/reflow.css"/></head>
<body>{body}</body></html>
"""


def _chapter_title(nodes, fallback: str) -> str:
    for n in nodes:
        if isinstance(n, Heading):
            return n.text
    return fallback


def _nav(chapters, titles, book_title: str) -> str:
    lis = "".join(f'<li><a href="chap-{i:03d}.xhtml">{html.escape(t)}</a></li>'
                  for i, t in enumerate(titles))
    return f"""<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><meta charset="utf-8"/><title>{html.escape(book_title)}</title></head>
<body><nav epub:type="toc" id="toc"><ol>{lis}</ol></nav></body></html>
"""


def _opf(chapters, images: List[str], title, language, font_items, modified) -> str:
    book_uuid = uuid.uuid5(uuid.NAMESPACE_DNS, "pdf2fxl-reflow:" + title)
    manifest = ['<item id="css" href="styles/reflow.css" media-type="text/css"/>']
    for fid, href, mt in font_items:
        manifest.append(f'<item id="{fid}" href="{href}" media-type="{mt}"/>')
    manifest.append('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>')
    spine = []
    for i, _ in enumerate(chapters):
        manifest.append(f'<item id="chap{i}" href="chap-{i:03d}.xhtml" '
                        'media-type="application/xhtml+xml"/>')
        spine.append(f'<itemref idref="chap{i}"/>')
    for j, img in enumerate(images):
        manifest.append(f'<item id="im{j}" href="images/{img}" media-type="image/png"/>')
    return f"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:{book_uuid}</dc:identifier>
    <dc:title>{html.escape(title)}</dc:title>
    <dc:language>{language}</dc:language>
    <meta property="dcterms:modified">{modified}</meta>
  </metadata>
  <manifest>{"".join(manifest)}</manifest>
  <spine>{"".join(spine)}</spine>
</package>
"""


def write_epub_reflow(doc: Doc, out_path: Path, font_path: str,
                      assets_root: Path, webfonts=None) -> Path:
    """Write a reflowable EPUB. `font_path` is the bundled base face (Latin/Greek/
    Cyrillic); `webfonts` is an optional list of FontFace for other scripts, each
    embedded and added to the font-family stack."""
    out_path = Path(out_path)
    assets_root = Path(assets_root)
    webfonts = webfonts or []
    base_name = Path(font_path).name
    base_family = font_family(font_path)
    modified = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    chapters = _split_chapters(doc.nodes)
    titles = [_chapter_title(ch, f"Chapter {i+1}") for i, ch in enumerate(chapters)]
    images: List[str] = []
    for n in doc.nodes:
        src = getattr(n, "src", None) or getattr(n, "image_src", None)
        if src:
            images.append(Path(src).name)

    # base face + one embedded woff2 per script webface
    faces: List[Tuple[str, str, int, str]] = []
    font_items = [("font-base", f"fonts/{base_name}", "application/font-sfnt")]
    embed: List[Tuple[str, str]] = [(font_path, f"OEBPS/fonts/{base_name}")]
    used = {base_name}
    stack = [base_family]
    for i, wf in enumerate(webfonts):
        name = wf.path.name
        if name in used:
            name = f"{i}-{name}"
        used.add(name)
        faces.append((wf.family, name, wf.weight, wf.unicode_range))
        font_items.append((f"wf{i}", f"fonts/{name}", "font/woff2"))
        embed.append((str(wf.path), f"OEBPS/fonts/{name}"))
        if wf.family not in stack:
            stack.append(wf.family)

    with zipfile.ZipFile(out_path, "w") as z:
        z.writestr("mimetype", "application/epub+zip", zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", CONTAINER_XML, zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/styles/reflow.css",
                   _css(base_name, base_family, faces, stack), zipfile.ZIP_DEFLATED)
        for src, dest in embed:
            z.write(src, dest, zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/content.opf",
                   _opf(chapters, images, doc.title, doc.language, font_items, modified),
                   zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/nav.xhtml", _nav(chapters, titles, doc.title), zipfile.ZIP_DEFLATED)
        for i, ch in enumerate(chapters):
            z.writestr(f"OEBPS/chap-{i:03d}.xhtml", _chapter_xhtml(ch, titles[i]),
                       zipfile.ZIP_DEFLATED)
        for img in images:
            p = assets_root / img
            if p.exists():
                z.write(str(p), f"OEBPS/images/{img}", zipfile.ZIP_DEFLATED)
    return out_path
