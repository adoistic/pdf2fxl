from pdf2fxl.config import Config
from pdf2fxl.style import font_for

def test_font_for_known_script():
    assert font_for("Latn", Config()) == "Noto Serif"

def test_font_for_unknown_script_falls_back_to_latin():
    assert font_for("Taml", Config()) == "Noto Serif"   # v1: Latin fallback
