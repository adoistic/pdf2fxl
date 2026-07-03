from __future__ import annotations
from datetime import datetime, timezone
from pathlib import Path
from typing import List
import html
import uuid
import zipfile

from .fittext import font_family
from .models import Page

CONTAINER_XML = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf"
     media-type="application/oebps-package+xml"/></rootfiles>
</container>
"""

def _page_css(font_file: str, family: str) -> str:
    """CSS bound to the actually-embedded font (family + file), so a per-script
    ``--font`` renders instead of falling back to a missing hardcoded face."""
    return f"""@font-face {{ font-family: "{family}";
  src: url("../fonts/{font_file}"); }}
html, body {{ margin: 0; padding: 0; }}
.page {{ position: relative; width: 100%; }}
.bg {{ display: block; width: 100%; height: auto; }}
.tb {{ position: absolute; margin: 0; font-family: "{family}", serif;
  line-height: 1.2; overflow: visible; }}
"""


def _page_xhtml(page: Page, img_name: str) -> str:
    w, h = page.page_size_px
    parts = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<!DOCTYPE html>',
        '<html xmlns="http://www.w3.org/1999/xhtml" '
        'xmlns:epub="http://www.idpf.org/2007/ops">',
        '<head>', '<meta charset="utf-8"/>',
        f'<meta name="viewport" content="width={w}, height={h}"/>',
        '<link rel="stylesheet" type="text/css" href="styles/page.css"/>',
        '</head>', '<body>', '<div class="page">',
        f'<img class="bg" src="images/{img_name}" alt=""/>',
    ]
    for b in sorted(page.blocks, key=lambda z: z.reading_order):
        x, y, bw, bh = b.bbox
        style = (
            f"left:{x / w * 100:.3f}%;top:{y / h * 100:.3f}%;"
            f"width:{bw / w * 100:.3f}%;"
            f"font-size:{b.font_px:.2f}px;color:{b.color};text-align:{b.align};"
        )
        parts.append(f'<div class="tb" style="{style}">{html.escape(b.text)}</div>')
    parts += ['</div>', '</body>', '</html>']
    return "\n".join(parts)


def _opf(pages: List[Page], title: str, language: str, font_name: str,
         modified: str) -> str:
    book_uuid = uuid.uuid5(uuid.NAMESPACE_DNS, "pdf2fxl:" + title)
    manifest = [
        '<item id="css" href="styles/page.css" media-type="text/css"/>',
        f'<item id="font" href="fonts/{font_name}" '
        'media-type="application/font-sfnt"/>',
        '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" '
        'properties="nav"/>',
    ]
    spine = []
    for i, _ in enumerate(pages):
        img_item = f'<item id="img{i}" href="images/page-{i:02d}.png" media-type="image/png"'
        if i == 0:
            img_item += ' properties="cover-image"'
        img_item += '/>'
        manifest.append(img_item)
        manifest.append(f'<item id="pg{i}" href="page-{i:02d}.xhtml" '
                        'media-type="application/xhtml+xml"/>')
        spine.append(f'<itemref idref="pg{i}"/>')
    return f"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid"
         prefix="rendition: http://www.idpf.org/vocab/rendition/#">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:{book_uuid}</dc:identifier>
    <dc:title>{html.escape(title)}</dc:title>
    <dc:language>{language}</dc:language>
    <meta property="dcterms:modified">{modified}</meta>
    <meta property="rendition:layout">pre-paginated</meta>
    <meta property="rendition:orientation">landscape</meta>
    <meta property="rendition:spread">both</meta>
  </metadata>
  <manifest>
    {"".join(manifest)}
  </manifest>
  <spine>
    {"".join(spine)}
  </spine>
</package>
"""


def _nav(pages: List[Page], title: str) -> str:
    lis = "".join(f'<li><a href="page-{i:02d}.xhtml">Page {i + 1}</a></li>'
                  for i in range(len(pages)))
    return f"""<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><meta charset="utf-8"/><title>{html.escape(title)}</title></head>
<body><nav epub:type="toc" id="toc"><ol>{lis}</ol></nav></body></html>
"""


def write_epub(pages: List[Page], out_path: Path, title: str, language: str,
               font_path: str) -> Path:
    out_path = Path(out_path)
    font_name = Path(font_path).name
    family = font_family(font_path)
    modified = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    with zipfile.ZipFile(out_path, "w") as z:
        z.writestr("mimetype", "application/epub+zip", zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", CONTAINER_XML, zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/styles/page.css", _page_css(font_name, family),
                   zipfile.ZIP_DEFLATED)
        z.write(font_path, f"OEBPS/fonts/{font_name}", zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/content.opf",
                   _opf(pages, title, language, font_name, modified),
                   zipfile.ZIP_DEFLATED)
        z.writestr("OEBPS/nav.xhtml", _nav(pages, title), zipfile.ZIP_DEFLATED)
        for i, page in enumerate(pages):
            img_name = f"page-{i:02d}.png"
            z.write(page.background, f"OEBPS/images/{img_name}", zipfile.ZIP_DEFLATED)
            z.writestr(f"OEBPS/page-{i:02d}.xhtml", _page_xhtml(page, img_name),
                       zipfile.ZIP_DEFLATED)
    return out_path
