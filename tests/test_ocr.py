from pdf2fxl.ocr import parse_ocr_response
from pdf2fxl.config import Config

def test_parser_keeps_text_drops_footer_and_image(ocr_response):
    cfg = Config()
    blocks = parse_ocr_response(ocr_response, page_size_px=(2000, 1500), cfg=cfg)
    assert len(blocks) == 1
    b = blocks[0]
    assert b.type == "text"
    assert b.text == "Anita was a painter."
    # 1000x750 -> 2000x1500 is a 2x scale; box (100,200,300,80) -> (200,400,600,160)
    assert b.bbox == (200.0, 400.0, 600.0, 160.0)
    assert b.reading_order == 0
    assert b.confidence == 0.98

def test_parser_assigns_sequential_reading_order(ocr_response):
    ocr_response["pages"][0]["blocks"].append(
        {"type": "text", "top_left_x": 100, "top_left_y": 300,
         "bottom_right_x": 400, "bottom_right_y": 360, "content": "Second."})
    blocks = parse_ocr_response(ocr_response, page_size_px=(1000, 750), cfg=Config())
    assert [b.reading_order for b in blocks] == [0, 1]

def test_parser_drops_full_page_block(ocr_response):
    # a block spanning nearly the whole 1000x750 page is a degenerate OCR catch-all
    ocr_response["pages"][0]["blocks"] = [
        {"type": "text", "top_left_x": 5, "top_left_y": 5,
         "bottom_right_x": 995, "bottom_right_y": 745, "content": "1"},
    ]
    blocks = parse_ocr_response(ocr_response, page_size_px=(1000, 750), cfg=Config())
    assert blocks == []

def test_parser_drops_empty_text_block(ocr_response):
    ocr_response["pages"][0]["blocks"] = [
        {"type": "text", "top_left_x": 10, "top_left_y": 10,
         "bottom_right_x": 200, "bottom_right_y": 60, "content": "   "},
    ]
    blocks = parse_ocr_response(ocr_response, page_size_px=(1000, 750), cfg=Config())
    assert blocks == []
