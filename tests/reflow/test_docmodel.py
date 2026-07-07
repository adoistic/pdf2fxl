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


def test_run_underline_round_trips():
    doc = Doc(title="T", language="en", nodes=[
        Paragraph(runs=[Run(text="plain "),
                        Run(text="under", underline=True),
                        Run(text=" both", bold=True, underline=True)]),
    ])
    restored = Doc.from_json(doc.to_json())
    runs = restored.nodes[0].runs
    assert runs[0].underline is False
    assert runs[1].underline is True and runs[1].bold is False
    assert runs[2].underline is True and runs[2].bold is True


def test_old_doc_json_without_underline_defaults_false():
    # A doc.json written before the underline field existed must still load.
    import json
    legacy = json.dumps({
        "title": "T", "language": "en",
        "nodes": [{"_kind": "Paragraph",
                   "runs": [{"text": "hi", "bold": False, "italic": False,
                             "dropcap": False}]}],
    })
    restored = Doc.from_json(legacy)
    assert restored.nodes[0].runs[0].underline is False
