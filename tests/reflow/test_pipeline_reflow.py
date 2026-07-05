import numpy as np
from pathlib import Path
from pdf2fxl.config import Config
from pdf2fxl.reflow.pipeline_reflow import convert_book_reflow

FONT = "assets/fonts/NotoSerif-Regular.ttf"

FAKE_RESP = {"pages": [{
    "dimensions": {"width": 300, "height": 400},
    "blocks": [
        {"type": "title", "top_left_x": 20, "top_left_y": 10,
         "bottom_right_x": 280, "bottom_right_y": 34, "content": "# Chapter One"},
        {"type": "text", "top_left_x": 20, "top_left_y": 80,
         "bottom_right_x": 280, "bottom_right_y": 140,
         "content": "Body sentence one. Body sentence two."},
    ],
}]}


def _fake_ocr(image_bgr, cfg, api_key):
    return FAKE_RESP


def _fake_pages(monkeypatch):
    import pdf2fxl.reflow.pipeline_reflow as mod
    img = np.full((400, 300, 3), 255, np.uint8)
    img[10:34, 20:280] = 0
    for i in range(3):
        img[80 + i * 20:88 + i * 20, 20:280] = 0
    monkeypatch.setattr(mod, "page_count", lambda p: 1)
    monkeypatch.setattr(mod, "rasterize_page", lambda p, i, z: img)
    monkeypatch.setattr(mod, "trimbox_px", lambda p, i, z: None)
    monkeypatch.setattr(mod, "trim_page", lambda im, trim=None: im)


def test_convert_book_reflow_writes_all_formats(tmp_path, monkeypatch):
    _fake_pages(monkeypatch)
    cfg = Config(mode="reflow")
    outputs = convert_book_reflow("dummy.pdf", tmp_path, cfg=cfg, ocr_fn=_fake_ocr,
                                  api_key="x", title="Book", language="en",
                                  font_path=FONT)
    kinds = {p.suffix for p in outputs}
    assert ".epub" in kinds and ".md" in kinds and ".docx" in kinds
    assert all(p.exists() for p in outputs)
    md = next(p for p in outputs if p.suffix == ".md").read_text()
    assert "# Chapter One" in md
