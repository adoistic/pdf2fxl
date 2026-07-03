# Shared fixtures are added by later tasks.
import numpy as np
import pytest
from PIL import Image


@pytest.fixture
def page_with_marks():
    """White page: big gray art block, thin black crop marks in the margins,
    a small black slug blob at the bottom. content_bbox() should return the art block."""
    img = np.full((400, 500, 3), 255, np.uint8)     # white BGR
    img[40:340, 60:440] = (200, 200, 200)           # art region -> (60,40)..(440,340)
    img[8:9, 8:28] = 0; img[8:28, 8:9] = 0          # top-left crop mark (thin)
    img[391:392, 470:495] = 0                       # bottom-right crop mark (thin)
    img[375:385, 200:300] = 0                       # slug blob (short, thin)
    return img


@pytest.fixture
def ocr_response():
    """Shape mirrors Mistral OCR 4 `blocks` output; coords are in the returned
    `dimensions` space (here 1000x750), to be scaled to page_size_px."""
    return {"pages": [{
        "index": 0,
        "dimensions": {"width": 1000, "height": 750},
        "markdown": "# ...",
        "blocks": [
            {"type": "text", "top_left_x": 100, "top_left_y": 200,
             "bottom_right_x": 400, "bottom_right_y": 280,
             "content": "Anita was a painter.", "confidence": 0.98},
            {"type": "footer", "top_left_x": 20, "top_left_y": 730,
             "bottom_right_x": 300, "bottom_right_y": 745,
             "content": "Book-English.indd  3   10/19/2022", "confidence": 0.9},
            {"type": "image", "top_left_x": 0, "top_left_y": 0,
             "bottom_right_x": 600, "bottom_right_y": 500, "content": ""},
        ],
    }]}


class FakeInpainter:
    """Deterministic stand-in: paints masked pixels solid red, leaves the rest."""
    def __call__(self, image: Image.Image, mask: Image.Image) -> Image.Image:
        import numpy as np
        rgb = np.array(image.convert("RGB"))
        m = np.array(mask.convert("L")) > 0
        rgb[m] = (255, 0, 0)
        return Image.fromarray(rgb)


@pytest.fixture
def fake_inpainter():
    return FakeInpainter()
