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
