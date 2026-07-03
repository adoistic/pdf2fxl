import numpy as np
from pdf2fxl.ingest import content_bbox, trim_page

def test_content_bbox_ignores_thin_marks(page_with_marks):
    x0, y0, x1, y1 = content_bbox(page_with_marks, white_thresh=245, open_ksize=15)
    # Should snap to the art block (60,40)-(440,340), not the crop marks or slug.
    assert abs(x0 - 60) <= 2 and abs(y0 - 40) <= 2
    assert abs(x1 - 440) <= 2 and abs(y1 - 340) <= 2

def test_trim_page_crops_to_content(page_with_marks):
    out = trim_page(page_with_marks, trim=None)
    assert out.shape[0] == 300 and out.shape[1] == 380  # 340-40, 440-60 (±0)

def test_trim_page_respects_explicit_box(page_with_marks):
    out = trim_page(page_with_marks, trim=(10, 10, 110, 60))
    assert out.shape[0] == 50 and out.shape[1] == 100


import os, pytest
from pdf2fxl.ingest import rasterize_page, page_count

REAL_PDF = "/Users/siraj/Downloads/Little_Elephant.pdf"

@pytest.mark.slow
@pytest.mark.skipif(not os.path.exists(REAL_PDF), reason="sample PDF not present")
def test_rasterize_real_pdf():
    assert page_count(REAL_PDF) == 20
    img = rasterize_page(REAL_PDF, 0, zoom=2.0)
    assert img.ndim == 3 and img.shape[2] == 3 and img.shape[0] > 100
