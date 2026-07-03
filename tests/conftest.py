# Shared fixtures are added by later tasks.
import numpy as np
import pytest


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
