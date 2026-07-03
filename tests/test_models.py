from pdf2fxl.models import Block, Page

def test_page_json_roundtrip():
    page = Page(
        index=7, page_size_px=(2048, 1536),
        background="page-07-clean.png", original="page-07.png",
        blocks=[Block(type="text", bbox=(10.0, 20.0, 300.0, 80.0),
                      text="Anita was a painter.", font_px=34.0,
                      color="#1a1a1a", align="left", reading_order=0, confidence=0.98)],
    )
    restored = Page.from_json(page.to_json())
    assert restored == page
    assert restored.blocks[0].bbox == (10.0, 20.0, 300.0, 80.0)

def test_empty_blocks_roundtrip():
    page = Page(index=0, page_size_px=(100, 100),
                background="b.png", original="o.png", blocks=[])
    assert Page.from_json(page.to_json()) == page
