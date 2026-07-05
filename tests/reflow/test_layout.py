from pdf2fxl.reflow.layout import detect_columns
from pdf2fxl.reflow.segment import Segment


def _seg(x, w=200, y=0, h=20, text="t"):
    return Segment(page_index=0, type="text", bbox=(x, y, w, h), text=text)


def test_two_up_split_assigns_columns():
    page_w = 1000
    left = [_seg(50, y=i * 30) for i in range(5)]     # x-center ~150
    right = [_seg(600, y=i * 30) for i in range(5)]   # x-center ~700
    segs = left + right
    detect_columns(segs, page_width=page_w, mode="auto")
    assert all(s.column == 0 for s in left)
    assert all(s.column == 1 for s in right)


def test_single_column_all_zero():
    page_w = 1000
    segs = [_seg(100, w=800, y=i * 30) for i in range(6)]
    detect_columns(segs, page_width=page_w, mode="auto")
    assert all(s.column == 0 for s in segs)


def test_forced_single_mode_never_splits():
    page_w = 1000
    segs = [_seg(50), _seg(600)]
    detect_columns(segs, page_width=page_w, mode="single")
    assert all(s.column == 0 for s in segs)
