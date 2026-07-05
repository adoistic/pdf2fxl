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


def _css(font_file: str, family: str) -> str:
    return f"""@font-face {{ font-family: "{family}"; src: url("fonts/{font_file}"); }}
html, body {{ font-family: "{family}", serif; line-height: 1.5; margin: 1em; }}
h1, h2, h3, h4, h5, h6 {{ line-height: 1.2; }}
figure {{ margin: 1em 0; text-align: center; }}
img {{ max-width: 100%; height: auto; }}
figcaption {{ font-size: 0.9em; color: #444; }}
"""


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


def _opf(chapters, images: List[str], title, language, font_name, modified) -> str:
    book_uuid = uuid.uuid5(uuid.NAMESPACE_DNS, "pdf2fxl-reflow:" + title)
    manifest = [
        '<item id="css" href="styles/reflow.css" media-type="text/css"/>',
        f'<item id="font" href="fonts/{font_name}" media-type="application/font-sfnt"/>',
        '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    ]
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
                      assets_root: Path) -> Path:
    out_path = Path(out_path)
    assets_root = Path(assets_root)
    font_name = Path(font_path).name
    family = font_family(font_path)
    modified = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    chapters = _split_chapters(doc.nodes)
    titles = [_chapter_title(ch, f"Chapter {i+1}") for i, ch in enumerate(chapters)]
    images: List[str] = []
    for n in doc.nodes:
        src = getattr(n, "src", None) or getattr(n, "image_src", None)
        if src:
            images.append(Path(src).name)
    with zipfile.ZipFile(out_path, "w") as z:
        z.writestr("mimetype", "application/epub+zip", zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", CONTAINER_XML, zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/styles/reflow.css", _css(font_name, family), zipfile.ZIP_DEFLATED)
        z.write(font_path, f"OEBPS/fonts/{font_name}", zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/content.opf",
                   _opf(chapters, images, doc.title, doc.language, font_name, modified),
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
