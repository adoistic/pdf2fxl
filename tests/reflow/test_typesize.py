import numpy as np
from pdf2fxl.reflow.typesize import measure_segment
from pdf2fxl.reflow.segment import Segment


def _striped(page_h=200, page_w=100, band_h=8, pitch=16, n=5, top=20):
    """White page with n dark horizontal bands of thickness band_h at given pitch."""
    img = np.full((page_h, page_w), 255, np.uint8)
    for i in range(n):
        y = top + i * pitch
        img[y:y + band_h, 10:90] = 0
    return img


def test_measures_line_count_and_size():
    img = _striped()
    seg = Segment(page_index=0, type="text", bbox=(0, 0, 100, 200), text="x")
    measure_segment(img, seg)
    assert seg.n_lines == 5
    # band thickness ~ 8 px
    assert 6 <= seg.size_px <= 10


def test_single_line_uses_band_thickness():
    img = _striped(n=1)
    seg = Segment(page_index=0, type="title", bbox=(0, 0, 100, 200), text="Title")
    measure_segment(img, seg)
    assert seg.n_lines == 1
    assert 6 <= seg.size_px <= 10


def test_blank_region_is_safe():
    img = np.full((50, 50), 255, np.uint8)
    seg = Segment(page_index=0, type="text", bbox=(0, 0, 50, 50), text="")
    measure_segment(img, seg)
    assert seg.size_px == 0.0
    assert seg.n_lines == 1


from pdf2fxl.reflow.typesize import detect_weight_centering


def test_centered_block_flagged():
    # ink only in the middle third of the crop width
    img = np.full((40, 300), 255, np.uint8)
    img[10:30, 120:180] = 0
    seg = Segment(page_index=0, type="title", bbox=(0, 0, 300, 40), text="Hi")
    detect_weight_centering(img, seg, page_width=300)
    assert seg.centered is True


def test_left_flush_block_not_centered():
    img = np.full((40, 300), 255, np.uint8)
    img[10:30, 0:60] = 0
    seg = Segment(page_index=0, type="title", bbox=(0, 0, 300, 40), text="Hi")
    detect_weight_centering(img, seg, page_width=300)
    assert seg.centered is False
