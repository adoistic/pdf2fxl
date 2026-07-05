from pdf2fxl.reflow.ocr_reflow import parse_ocr_reflow

RESP = {
    "pages": [{
        "dimensions": {"width": 100, "height": 200},
        "blocks": [
            {"type": "title", "top_left_x": 10, "top_left_y": 5,
             "bottom_right_x": 90, "bottom_right_y": 20, "content": "# Chapter One"},
            {"type": "text", "top_left_x": 10, "top_left_y": 25,
             "bottom_right_x": 90, "bottom_right_y": 60,
             "content": "line one\nline two"},
            {"type": "image", "top_left_x": 10, "top_left_y": 65,
             "bottom_right_x": 90, "bottom_right_y": 120, "content": ""},
            {"type": "page_number", "top_left_x": 45, "top_left_y": 190,
             "bottom_right_x": 55, "bottom_right_y": 198, "content": "12"},
        ],
    }]
}


def test_keeps_images_and_headings_and_line_breaks():
    segs = parse_ocr_reflow(RESP, (100, 200))
    types = [s.type for s in segs]
    assert "image" in types                    # images kept (dropped in fxl path)
    assert "title" in types
    # heading markdown marker stripped, text preserved
    title = next(s for s in segs if s.type == "title")
    assert title.text == "Chapter One"
    # newlines preserved so line count is recoverable
    body = next(s for s in segs if s.type == "text")
    assert body.text == "line one\nline two"


def test_scales_bbox_to_page_pixels():
    segs = parse_ocr_reflow(RESP, (200, 400))   # 2x
    title = next(s for s in segs if s.type == "title")
    x, y, w, h = title.bbox
    assert abs(x - 20) < 1e-6 and abs(w - 160) < 1e-6
