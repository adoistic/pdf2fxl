from pdf2fxl.config import Config


def test_reflow_defaults():
    c = Config()
    assert c.mode == "fxl"
    assert c.reflow_formats == ("epub", "md", "docx")
    assert c.reflow_tables == "html"
    assert c.reflow_figures == "image"
    assert c.reflow_formulas == "image"
    assert c.reflow_layout == "auto"
    assert c.promote_runins is False
