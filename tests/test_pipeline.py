import numpy as np
from pathlib import Path
from PIL import Image
from pptx import Presentation
import zipfile
from pdf2fxl.config import Config
from pdf2fxl.pipeline import convert_book


def _fake_ocr_fn(response):
    def fn(image_bgr, cfg, api_key):
        return response
    return fn


def test_convert_book_produces_epub_and_pptx(tmp_path, ocr_response, fake_inpainter, monkeypatch):
    # one synthetic PDF page: white with a dark text bar in the text-block region
    import fitz
    pdf = tmp_path / "tiny.pdf"
    doc = fitz.open(); page = doc.new_page(width=500, height=375)  # 4:3
    page.insert_text((60, 120), "Anita was a painter.", fontsize=20)
    doc.save(str(pdf)); doc.close()

    # OCR fixture describes one text block over that region (dims match render size)
    resp = ocr_response
    out_dir = tmp_path / "out"
    epub, pptx = convert_book(
        str(pdf), out_dir, cfg=Config(zoom=2.0, trim_strategy="none"),
        ocr_fn=_fake_ocr_fn(resp), inpainter=fake_inpainter,
        api_key="x", title="Tiny", language="en",
        font_path="assets/fonts/NotoSerif-Regular.ttf")

    assert epub.exists() and pptx.exists()
    with zipfile.ZipFile(epub) as z:
        assert "OEBPS/page-00.xhtml" in z.namelist()
    assert len(Presentation(str(pptx)).slides) == 1
    # intermediate JSON written for inspection
    assert (out_dir / "pages" / "page-00.json").exists()
