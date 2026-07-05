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


from pdf2fxl.reflow.layout import strip_running


def _mk(page_index, text, y, h_page=1000):
    return Segment(page_index=page_index, type="text", bbox=(50, y, 200, 20),
                   text=text)


def test_removes_page_numbers_and_repeated_running_heads():
    pages = []
    for p in range(4):
        pages.append([
            _mk(p, str(12 + p), y=970),               # page number in bottom band
            _mk(p, "The Book Title", y=975),          # repeated running head
            _mk(p, f"Unique body text {p}", y=500),   # real content
        ])
    kept = strip_running(pages, page_height=1000)
    flat = [s.text for page in kept for s in page]
    assert all(not t.isdigit() for t in flat)
    assert "The Book Title" not in flat
    assert any(t.startswith("Unique body text") for t in flat)
