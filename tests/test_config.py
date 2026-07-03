from pdf2fxl.config import Config

def test_defaults():
    c = Config()
    assert c.zoom == 300 / 72          # ~4.1667, i.e. 300 DPI render
    assert c.ocr_model == "mistral-ocr-4-0"
    assert "footer" in c.drop_block_types
    assert "text" in c.keep_block_types
    assert c.font_map["Latn"] == "Noto Serif"
    assert c.mask_dilate_px == 2
    assert c.trim_strategy == "content"

def test_override():
    c = Config(zoom=2.0, mask_dilate_px=5)
    assert c.zoom == 2.0 and c.mask_dilate_px == 5
