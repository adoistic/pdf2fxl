import numpy as np
from pathlib import Path
from PIL import Image
from pdf2fxl.reflow.crop import crop_region, width_frac, classify_image


def test_crop_writes_png(tmp_path):
    img = np.zeros((100, 100, 3), np.uint8)
    img[20:60, 10:70] = 255
    out = crop_region(img, (10, 20, 60, 40), tmp_path / "fig-0.png", pad=0)
    assert out.exists()
    w, h = Image.open(out).size
    assert (w, h) == (60, 40)


def test_width_frac_is_bbox_over_column():
    assert abs(width_frac(300, column_width=600) - 0.5) < 1e-6
    assert width_frac(900, column_width=600) == 1.0   # clamped


def test_classify_by_area_fraction():
    assert classify_image(area_frac=0.6) == "plate"
    assert classify_image(area_frac=0.2) == "figure"
    assert classify_image(area_frac=0.01) == "inline"
