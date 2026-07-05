from pdf2fxl.reflow.hierarchy import body_size
from pdf2fxl.reflow.segment import Segment


def _seg(type_, size, text):
    return Segment(page_index=0, type=type_, bbox=(0, 0, 10, 10), text=text,
                   size_px=size)


def test_body_size_is_the_char_mass_peak():
    segs = [
        _seg("text", 10.0, "x" * 500),   # lots of body at size 10
        _seg("text", 10.2, "y" * 400),
        _seg("title", 20.0, "Big Heading"),   # heading excluded
        _seg("text", 30.0, "z" * 5),     # tiny amount of large text
    ]
    assert 9.5 <= body_size(segs) <= 10.7


def test_body_size_empty_returns_zero():
    assert body_size([]) == 0.0


from pdf2fxl.reflow.hierarchy import parse_numbering


def test_dotted_decimal_depth():
    assert parse_numbering("1. Introduction") == 1
    assert parse_numbering("1.2 Historical Perspective") == 2
    assert parse_numbering("1.2.1. Early Discoveries") == 3


def test_roman_and_chapter_are_top_level():
    assert parse_numbering("IV. Methods") == 1
    assert parse_numbering("Chapter 3 The Gut") == 1


def test_devanagari_numeral_prefix():
    assert parse_numbering("२. प्रकरण") == 1


def test_no_numbering_returns_zero():
    assert parse_numbering("Introduction") == 0
    assert parse_numbering("Opportunity: consider this") == 0
