import zipfile
from pathlib import Path
from pdf2fxl.reflow.render_epub_reflow import write_epub_reflow
from pdf2fxl.reflow.docmodel import Doc, Heading, Paragraph, Run, ChapterBreak

FONT = "assets/fonts/NotoSerif-Regular.ttf"


def test_run_emphasis_renders_strong_em_underline(tmp_path):
    """Inline emphasis runs render as <strong>/<em>/<u>; a run with several
    styles nests all three so combined bold+italic+underline survives."""
    doc = Doc(title="T", language="en", nodes=[
        ChapterBreak(), Heading(level=1, text="One"),
        Paragraph(runs=[
            Run(text="a "),
            Run(text="b", bold=True),
            Run(text=" i", italic=True),
            Run(text=" u", underline=True),
            Run(text=" all", bold=True, italic=True, underline=True),
        ]),
    ])
    out = write_epub_reflow(doc, tmp_path / "b.epub", font_path=FONT, assets_root=tmp_path)
    with zipfile.ZipFile(out) as z:
        chap = next(z.read(n).decode() for n in z.namelist() if n.startswith("OEBPS/chap-"))
    assert "<strong>b</strong>" in chap
    assert "<em> i</em>" in chap
    assert "<u> u</u>" in chap
    # combined: order is strong>em>u from _runs_html
    assert "<u><em><strong> all</strong></em></u>" in chap


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


def test_css_has_heading_ladder_and_table_styling(tmp_path):
    """The stylesheet must give headings a real visual hierarchy (distinct,
    decreasing font sizes for h1..h3) and style tables with borders, so the
    computed heading levels and HTML tables are actually visible to the reader."""
    from pdf2fxl.reflow.docmodel import Table
    doc = Doc(title="T", language="en", nodes=[
        ChapterBreak(), Heading(level=1, text="Chapter"),
        Heading(level=2, text="Section"),
        Heading(level=3, text="Subsection"),
        Table(html="<table><tr><th>A</th></tr><tr><td>1</td></tr></table>",
              image_src=None, caption=None),
        Paragraph(runs=[Run(text="Body.")]),
    ])
    out = write_epub_reflow(doc, tmp_path / "b.epub", font_path=FONT, assets_root=tmp_path)
    import re
    with zipfile.ZipFile(out) as z:
        css = z.read("OEBPS/styles/reflow.css").decode()

    def size_em(selector: str) -> float:
        m = re.search(rf"(?m)^\s*{re.escape(selector)}\s*\{{[^}}]*font-size:\s*([0-9.]+)em", css)
        assert m, f"no font-size for {selector} in CSS:\n{css}"
        return float(m.group(1))

    h1, h2, h3 = size_em("h1"), size_em("h2"), size_em("h3")
    assert h1 > h2 > h3, f"headings not a decreasing ladder: h1={h1} h2={h2} h3={h3}"
    # Tables must have visible cell borders.
    assert re.search(r"(?m)^\s*(table\s+)?(th|td)[^{]*\{[^}]*border", css), \
        f"no table cell border rule in CSS:\n{css}"
    assert "border-collapse" in css
