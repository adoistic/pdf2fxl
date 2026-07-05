import numpy as np
from pdf2fxl.reflow.assemble import build_doc, PageInput
from pdf2fxl.reflow.segment import Segment
from pdf2fxl.reflow.docmodel import Heading, Paragraph, ChapterBreak


def _text_img(page_h=400, page_w=300):
    # 3 body lines (thin bands) + one big heading band near the top
    img = np.full((page_h, page_w), 255, np.uint8)
    img[10:34, 20:280] = 0                       # heading band (~24px thick)
    for i in range(3):
        y = 80 + i * 20
        img[y:y + 8, 20:280] = 0                 # body bands (~8px)
    return np.stack([img] * 3, axis=-1)          # to BGR


def test_build_doc_emits_heading_then_paragraph(tmp_path):
    img = _text_img()
    segs = [
        Segment(0, "title", (20, 10, 260, 24), "Chapter One"),
        Segment(0, "text", (20, 80, 260, 60), "Body sentence one. Body sentence two."),
    ]
    doc = build_doc([PageInput(img, (300, 400), segs)],
                    title="T", language="en", assets_dir=tmp_path)
    kinds = [type(n).__name__ for n in doc.nodes]
    assert "Heading" in kinds and "Paragraph" in kinds
    # ChapterBreak precedes the first heading
    hi = kinds.index("Heading")
    assert "ChapterBreak" in kinds[:hi + 1]
    h = next(n for n in doc.nodes if isinstance(n, Heading))
    assert h.level == 1 and h.text == "Chapter One"
