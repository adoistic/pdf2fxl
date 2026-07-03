import numpy as np
from pdf2fxl.inpaint import apply_inpainting

def test_apply_inpainting_changes_only_masked(fake_inpainter):
    img = np.full((10, 10, 3), 200, np.uint8)   # gray BGR
    mask = np.zeros((10, 10), np.uint8)
    mask[2:5, 2:5] = 255
    out = apply_inpainting(img, mask, fake_inpainter)
    assert out.shape == img.shape
    # masked region became red -> in BGR that's (0,0,255)
    assert (out[2:5, 2:5] == (0, 0, 255)).all()
    # a pixel outside the mask is unchanged
    assert (out[0, 0] == (200, 200, 200)).all()


import pytest
from pdf2fxl.inpaint import LamaInpainter, apply_inpainting

@pytest.mark.slow
def test_real_lama_runs():
    img = np.full((64, 64, 3), 180, np.uint8)
    img[28:36, 10:54] = 0                 # a dark "text" bar to erase
    mask = np.zeros((64, 64), np.uint8); mask[28:36, 10:54] = 255
    out = apply_inpainting(img, mask, LamaInpainter())
    assert out.shape == img.shape
    assert out[28:36, 10:54].mean() > 100   # bar lightened toward background
