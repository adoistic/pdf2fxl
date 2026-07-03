import numpy as np
from pdf2fxl.models import Block
from pdf2fxl.textmask import (block_text_mask, estimate_font_px,
                              estimate_color, estimate_align, build_page_mask,
                              _X_HEIGHT_RATIO)

def _canvas_with_glyphs():
    """White 200x300 image; three black 'glyph' bars height=20 at the left of a block."""
    img = np.full((200, 300, 3), 255, np.uint8)
    for gx in (30, 55, 80):                 # 3 bars, width 10, height 20, top=100
        img[100:120, gx:gx + 10] = 0
    return img

def test_block_text_mask_marks_dark_pixels():
    img = _canvas_with_glyphs()
    m = block_text_mask(img, bbox=(20, 90, 120, 40), dark_thresh=128)
    assert m.shape == (40, 120)
    assert m.max() == 255 and m.min() == 0
    assert int((m > 0).sum()) == 3 * 10 * 20   # exactly the three bars

def test_estimate_font_px_recovers_em_from_xheight():
    img = _canvas_with_glyphs()
    m = block_text_mask(img, bbox=(20, 90, 120, 40))
    # median glyph height 20px ~= x-height; em = 20 / ratio
    assert estimate_font_px(m) == 20.0 / _X_HEIGHT_RATIO

def test_estimate_color_black_text():
    img = _canvas_with_glyphs()
    bbox = (20, 90, 120, 40)
    m = block_text_mask(img, bbox)
    assert estimate_color(img, bbox, m) == "#000000"

def test_estimate_align_left():
    img = _canvas_with_glyphs()
    bbox = (20, 90, 120, 40)                 # glyphs start near left edge of block
    m = block_text_mask(img, bbox)
    assert estimate_align(m, block_w=120) == "left"

def _canvas_light_on_dark():
    """Dark 200x300 image; three WHITE 'glyph' bars in a block (light-on-dark)."""
    img = np.full((200, 300, 3), 20, np.uint8)
    for gx in (30, 55, 80):
        img[100:120, gx:gx + 10] = 255
    return img

def test_block_text_mask_light_on_dark_marks_glyphs():
    img = _canvas_light_on_dark()
    m = block_text_mask(img, bbox=(20, 90, 120, 40))
    # polarity inverted: the white bars (minority) are the text
    assert int((m > 0).sum()) == 3 * 10 * 20

def test_estimate_color_white_text_on_dark():
    img = _canvas_light_on_dark()
    bbox = (20, 90, 120, 40)
    m = block_text_mask(img, bbox)
    assert estimate_color(img, bbox, m) == "#ffffff"

def test_block_text_mask_out_of_bounds_returns_zeros():
    img = np.full((50, 50, 3), 255, np.uint8)
    m = block_text_mask(img, bbox=(100, 100, 20, 10))   # fully outside the image
    assert m.shape == (10, 20)
    assert int((m > 0).sum()) == 0

def test_build_page_mask_dilates_union():
    img = _canvas_with_glyphs()
    blocks = [Block(type="text", bbox=(20, 90, 120, 40), text="x")]
    mask = build_page_mask(img, blocks, dark_thresh=128, dilate_px=1)
    assert mask.shape == (200, 300)
    assert int((mask > 0).sum()) > 3 * 10 * 20   # dilated, so larger than raw glyphs
