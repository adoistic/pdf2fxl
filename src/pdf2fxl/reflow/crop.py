from __future__ import annotations
from pathlib import Path
from typing import Tuple
import cv2


def crop_region(image_bgr, bbox: Tuple[float, float, float, float],
                out_path: Path, pad: int = 4) -> Path:
    """Crop bbox (+pad) from the page image and write a PNG. Returns out_path."""
    h, w = image_bgr.shape[:2]
    x, y, bw, bh = (int(round(v)) for v in bbox)
    x0 = max(0, x - pad); y0 = max(0, y - pad)
    x1 = min(w, x + bw + pad); y1 = min(h, y + bh + pad)
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out_path), image_bgr[y0:y1, x0:x1])
    return out_path


def width_frac(bbox_w: float, column_width: float) -> float:
    """Image display width as a fraction of the text column (clamped to 1.0)."""
    if column_width <= 0:
        return 1.0
    return min(1.0, bbox_w / column_width)


def classify_image(area_frac: float) -> str:
    """plate (>=0.45 of page), figure (>=0.03), else inline."""
    if area_frac >= 0.45:
        return "plate"
    if area_frac >= 0.03:
        return "figure"
    return "inline"
