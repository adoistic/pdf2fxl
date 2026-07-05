from pdf2fxl.reflow.render_md import render_markdown
from pdf2fxl.reflow.docmodel import (Doc, Heading, Paragraph, Run, Figure, Table,
                                     ChapterBreak)


def test_markdown_headings_paragraphs_figures():
    doc = Doc(title="T", language="en", nodes=[
        ChapterBreak(),
        Heading(level=1, text="Chapter One"),
        Heading(level=2, text="Section"),
        Paragraph(runs=[Run(text="Hello "), Run(text="bold", bold=True)]),
        Figure(src="images/f.png", caption="Cap", width_frac=0.5, kind="figure"),
        Table(html="<table><tr><td>a</td></tr></table>", image_src=None, caption=None),
    ])
    md = render_markdown(doc)
    assert "# Chapter One" in md
    assert "## Section" in md
    assert "Hello **bold**" in md
    assert "![Cap](images/f.png)" in md
