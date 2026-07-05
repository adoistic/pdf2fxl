from pdf2fxl.reflow.segment import Segment, is_heading_type, HEADING_TYPES


def test_segment_defaults():
    s = Segment(page_index=0, type="text", bbox=(1.0, 2.0, 30.0, 40.0), text="hello")
    assert s.size_px == 0.0
    assert s.n_lines == 1
    assert s.level == 0
    assert s.column == 0
    assert s.bold is False


def test_heading_type_detection():
    assert is_heading_type("title") is True
    assert is_heading_type("section_header") is True
    assert is_heading_type("text") is False
    assert "title" in HEADING_TYPES
