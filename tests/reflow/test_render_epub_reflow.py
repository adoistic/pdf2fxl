import zipfile
from pathlib import Path
from pdf2fxl.reflow.render_epub_reflow import write_epub_reflow
from pdf2fxl.reflow.docmodel import Doc, Heading, Paragraph, Run, ChapterBreak

FONT = "assets/fonts/NotoSerif-Regular.ttf"


def test_epub_structure_and_chapter_split(tmp_path):
    doc = Doc(title="T", language="en", nodes=[
        ChapterBreak(), Heading(level=1, text="One"),
        Paragraph(runs=[Run(text="Alpha body.")]),
        ChapterBreak(), Heading(level=1, text="Two"),
        Paragraph(runs=[Run(text="Beta body.")]),
    ])
    out = write_epub_reflow(doc, tmp_path / "b.epub", font_path=FONT,
                            assets_root=tmp_path)
    assert out.exists()
    with zipfile.ZipFile(out) as z:
        names = z.namelist()
        assert "mimetype" in names
        assert "OEBPS/nav.xhtml" in names
        chapters = [n for n in names if n.startswith("OEBPS/chap-")]
        assert len(chapters) == 2                      # one file per H1
        nav = z.read("OEBPS/nav.xhtml").decode()
        assert "One" in nav and "Two" in nav
        c0 = z.read(chapters[0]).decode()
        assert "<h1" in c0 and "Alpha body." in c0
