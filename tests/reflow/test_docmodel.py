from pdf2fxl.reflow.docmodel import (Doc, Heading, Paragraph, Run, Figure, Table,
                                     Formula, ChapterBreak)


def test_doc_json_round_trip():
    doc = Doc(title="T", language="en", nodes=[
        ChapterBreak(),
        Heading(level=1, text="Chapter One"),
        Paragraph(runs=[Run(text="Hello "), Run(text="world", bold=True)]),
        Figure(src="images/fig-0.png", caption="Fig 1", width_frac=0.5, kind="figure"),
        Table(html="<table></table>", image_src=None, caption="Tab 1"),
        Formula(mathml=None, text="E=mc^2", image_src=None, caption=None),
    ])
    restored = Doc.from_json(doc.to_json())
    assert restored.title == "T"
    assert isinstance(restored.nodes[1], Heading)
    assert restored.nodes[1].level == 1
    assert restored.nodes[2].runs[1].bold is True
    assert isinstance(restored.nodes[3], Figure)
    assert restored.nodes[3].width_frac == 0.5
