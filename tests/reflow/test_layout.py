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


from pdf2fxl.reflow.layout import order_segments, merge_dropcaps, rejoin_paragraphs


def test_order_left_column_before_right_then_top_down():
    r1 = Segment(0, "text", (600, 10, 200, 20), "right-top"); r1.column = 1
    l1 = Segment(0, "text", (50, 40, 200, 20), "left-lower"); l1.column = 0
    l0 = Segment(0, "text", (50, 10, 200, 20), "left-top"); l0.column = 0
    ordered = order_segments([r1, l1, l0])
    assert [s.text for s in ordered] == ["left-top", "left-lower", "right-top"]


def test_dropcap_merges_into_next_paragraph():
    cap = Segment(0, "text", (50, 100, 40, 40), "S", size_px=40)
    para = Segment(0, "text", (95, 100, 300, 120), "chool begins here.", size_px=10)
    out = merge_dropcaps([cap, para], body_px=10.0)
    assert len(out) == 1
    assert out[0].text.startswith("School begins here")


def test_rejoin_paragraph_split_across_pages():
    a = Segment(0, "text", (0, 0, 10, 10), "the sentence continues")
    b = Segment(1, "text", (0, 0, 10, 10), "onto the next page.")
    out = rejoin_paragraphs([a, b])
    assert len(out) == 1
    assert out[0].text == "the sentence continues onto the next page."


def test_rejoin_keeps_separate_when_sentence_ends():
    a = Segment(0, "text", (0, 0, 10, 10), "A finished sentence.")
    b = Segment(1, "text", (0, 0, 10, 10), "Another one starts.")
    out = rejoin_paragraphs([a, b])
    assert len(out) == 2
