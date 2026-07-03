import zipfile
from lxml import etree
from pathlib import Path
from PIL import Image
from pdf2fxl.models import Page, Block
from pdf2fxl.render_epub import write_epub


def _one_page(tmp_path):
    bg = tmp_path / "page-00-clean.png"
    Image.new("RGB", (200, 150), (255, 255, 255)).save(bg)
    page = Page(index=0, page_size_px=(200, 150), background=str(bg), original=str(bg),
                blocks=[Block(type="text", bbox=(20, 30, 100, 40),
                              text="Hello world", font_px=18, color="#111111",
                              align="left", reading_order=0)])
    return page


def test_write_epub_is_valid_zip_with_mimetype_first(tmp_path):
    out = tmp_path / "book.epub"
    write_epub([_one_page(tmp_path)], out, title="Test", language="en",
               font_path="assets/fonts/NotoSerif-Regular.ttf")
    with zipfile.ZipFile(out) as z:
        names = z.namelist()
        assert names[0] == "mimetype"
        info = z.getinfo("mimetype")
        assert info.compress_type == zipfile.ZIP_STORED
        assert z.read("mimetype") == b"application/epub+zip"
        assert "OEBPS/content.opf" in names
        assert "OEBPS/page-00.xhtml" in names
        assert "OEBPS/fonts/NotoSerif-Regular.ttf" in names


def test_page_xhtml_has_viewport_and_positioned_text(tmp_path):
    out = tmp_path / "book.epub"
    write_epub([_one_page(tmp_path)], out, title="Test", language="en",
               font_path="assets/fonts/NotoSerif-Regular.ttf")
    with zipfile.ZipFile(out) as z:
        xhtml = z.read("OEBPS/page-00.xhtml").decode()
    root = etree.fromstring(xhtml.encode())
    ns = {"x": "http://www.w3.org/1999/xhtml"}
    meta = root.find(".//x:meta[@name='viewport']", ns)
    assert meta.get("content") == "width=200, height=150"
    div = root.find(".//x:div[@class='tb']", ns)
    assert "Hello world" in "".join(div.itertext())
    style = div.get("style")
    assert "left:10.000%" in style and "top:20.000%" in style   # 20/200, 30/150


def test_opf_has_required_epub3_metadata(tmp_path):
    import re, uuid
    out = tmp_path / "book.epub"
    write_epub([_one_page(tmp_path)], out, title="Test", language="en",
               font_path="assets/fonts/NotoSerif-Regular.ttf")
    with zipfile.ZipFile(out) as z:
        opf = z.read("OEBPS/content.opf").decode()
        nav = z.read("OEBPS/nav.xhtml").decode()
    assert 'property="dcterms:modified"' in opf
    m = re.search(r"urn:uuid:([0-9a-fA-F-]{36})", opf)
    assert m is not None and str(uuid.UUID(m.group(1))) == m.group(1)
    assert "<!DOCTYPE html>" in nav


import shutil, subprocess, pytest


@pytest.mark.slow
@pytest.mark.skipif(shutil.which("epubcheck") is None, reason="epubcheck not installed")
def test_epubcheck_passes(tmp_path):
    out = tmp_path / "book.epub"
    write_epub([_one_page(tmp_path)], out, title="Test", language="en",
               font_path="assets/fonts/NotoSerif-Regular.ttf")
    r = subprocess.run(["epubcheck", str(out)], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
