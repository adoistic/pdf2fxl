from pdf2fxl.fittext import (fit_font_px, wrapped_line_widths, font_family,
                             LINE_SPACING)

FONT = "assets/fonts/NotoSerif-Regular.ttf"
LOREM = ("Anita was a delightful painter. She had emerged successful in "
         "several painting competitions in her town. Her school friends "
         "were proud of her remarkable achievements.")


def _wrapped_height(text, px, box_w):
    lines = wrapped_line_widths(text, int(px), box_w, FONT)
    assert lines is not None
    return len(lines) * px * LINE_SPACING


def test_fit_never_overflows_box():
    box_w, box_h = 486.0, 255.0          # real Grandma block
    px = fit_font_px(LOREM, box_w, box_h, FONT)
    assert px >= 8
    # the guarantee: at the returned size, measured wrapped text fits the box
    assert _wrapped_height(LOREM, px, box_w * 0.96) <= box_h * 0.96 + 1e-6


def test_fit_is_maximal():
    box_w, box_h = 486.0, 255.0
    px = fit_font_px(LOREM, box_w, box_h, FONT)
    # one size larger must NOT fit (otherwise we under-sized)
    bigger = px + 1
    lines = wrapped_line_widths(LOREM, int(bigger), box_w * 0.96, FONT)
    assert lines is None or len(lines) * bigger * LINE_SPACING > box_h * 0.96


def test_longer_text_gets_smaller_or_equal_font():
    box = (400.0, 200.0)
    short = fit_font_px("Hello world", *box, FONT)
    long = fit_font_px(LOREM, *box, FONT)
    assert long <= short


def test_single_word_capped_by_height_and_width():
    px = fit_font_px("Hi", 400.0, 60.0, FONT)
    assert px * LINE_SPACING <= 60.0 * 0.96 + 1e-6   # height cap respected


def test_tiny_box_clamps_to_min():
    assert fit_font_px(LOREM, 30.0, 10.0, FONT) == 8.0


def test_empty_text_returns_min():
    assert fit_font_px("   ", 400.0, 200.0, FONT) == 8.0


def test_font_family_reads_name_table():
    assert font_family(FONT) == "Noto Serif"


def test_font_family_bad_path_falls_back():
    assert font_family("/no/such/font.ttf") == "serif"
