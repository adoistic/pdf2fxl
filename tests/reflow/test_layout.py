from pdf2fxl.reflow.layout import detect_columns
from pdf2fxl.reflow.segment import Segment, is_heading_type


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


# --- Defect A: trailing page numbers on real headings ---------------------

from pdf2fxl.reflow.layout import strip_heading_page_number, is_toc_line, clean_headings


def test_strip_trailing_page_number_from_heading():
    assert strip_heading_page_number("5 The Holobiont 51") == "5 The Holobiont"
    assert strip_heading_page_number(
        "4 The Cause of Disease: Genetic/Infectious/Dietary Hypotheses 32"
    ) == "4 The Cause of Disease: Genetic/Infectious/Dietary Hypotheses"


def test_keep_chapter_number_in_title():
    # "Chapter 21" / "Catch 22" — trailing number is part of the title (only one
    # other word), must be preserved.
    assert strip_heading_page_number("Chapter 21") == "Chapter 21"
    assert strip_heading_page_number("Catch 22") == "Catch 22"


def test_keep_section_numbering_untouched():
    assert strip_heading_page_number("2.1. Disease") == "2.1. Disease"
    assert strip_heading_page_number("2. Between Health and Disease") == \
        "2. Between Health and Disease"


def test_heading_that_is_only_a_number_is_left_alone():
    # A heading that is ONLY a number is left for strip_running; do not empty it.
    assert strip_heading_page_number("51") == "51"


def test_keep_number_right_after_leading_section_number():
    # "5 51" — leading section number immediately followed by a number; too
    # ambiguous / not enough other words, keep as-is.
    assert strip_heading_page_number("5 The Holobiont") == "5 The Holobiont"


# --- Defect B: Table-of-Contents lines leak in as headings ----------------


def test_toc_line_with_dot_leaders_detected():
    assert is_toc_line("Part 1. Gene-Focused Approaches to Disease . . . . . . 19")
    assert is_toc_line("References . . . 29")
    assert is_toc_line("Introduction ...................... 5")


def test_real_heading_with_period_is_not_toc():
    assert not is_toc_line("2.1. Disease")
    assert not is_toc_line("2. Between Health and Disease")
    assert not is_toc_line("5 The Holobiont")
    assert not is_toc_line("The Cause of Disease: A Hypothesis")


def _hd(text, type_="section_header", size=18.0):
    return Segment(page_index=0, type=type_, bbox=(0, 0, 200, 20), text=text,
                   size_px=size)


def test_clean_headings_demotes_toc_lines_to_text():
    segs = [_hd("Part 1. Gene-Focused Approaches . . . . . . 19"),
            _hd("References . . . . . . . 29")]
    clean_headings(segs)
    assert all(s.type == "text" for s in segs)


def test_clean_headings_strips_page_numbers_and_keeps_real_headings():
    real = _hd("5 The Holobiont 51")
    body_heading = _hd("2. Between Health and Disease")
    clean_headings([real, body_heading])
    assert is_heading_type(real.type)
    assert real.text == "5 The Holobiont"
    assert body_heading.text == "2. Between Health and Disease"


def test_clean_headings_leaves_body_text_untouched():
    body = Segment(0, "text", (0, 0, 200, 20),
                   "Some body sentence ending in 2019.", size_px=10.0)
    clean_headings([body])
    assert body.type == "text"
    assert body.text == "Some body sentence ending in 2019."
