from __future__ import annotations
from typing import List, Tuple
import cv2
import numpy as np

from .models import Block


def _ints(bbox: Tuple[float, float, float, float]) -> Tuple[int, int, int, int]:
    x, y, w, h = bbox
    return int(round(x)), int(round(y)), int(round(w)), int(round(h))


def block_text_mask(img_bgr: np.ndarray, bbox, dark_thresh: int = 128) -> np.ndarray:
    """ROI-local mask: dark pixels -> 255 (text), else 0."""
    x, y, w, h = _ints(bbox)
    roi = img_bgr[y:y + h, x:x + w]
    if roi.size == 0:
        return np.zeros((max(h, 0), max(w, 0)), np.uint8)
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    _, m = cv2.threshold(gray, dark_thresh, 255, cv2.THRESH_BINARY_INV)
    return m


def estimate_font_px(mask: np.ndarray) -> float:
    """Median connected-component height ~= glyph height."""
    n, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    heights = [int(stats[i, cv2.CC_STAT_HEIGHT]) for i in range(1, n)]
    return float(np.median(heights)) if heights else 0.0


def estimate_color(img_bgr: np.ndarray, bbox, mask: np.ndarray) -> str:
    x, y, w, h = _ints(bbox)
    roi = img_bgr[y:y + h, x:x + w]
    pix = roi[mask > 0]
    if len(pix) == 0:
        return "#000000"
    b, g, r = (int(v) for v in np.median(pix, axis=0))
    return "#{:02x}{:02x}{:02x}".format(r, g, b)


def estimate_align(mask: np.ndarray, block_w: int) -> str:
    cols = np.where(mask.sum(axis=0) > 0)[0]
    if len(cols) == 0:
        return "left"
    left = int(cols[0])
    right = int(mask.shape[1] - 1 - cols[-1])
    if abs(left - right) <= 0.1 * block_w:
        return "center"
    return "left" if left <= right else "right"


def build_page_mask(img_bgr: np.ndarray, blocks: List[Block],
                    dark_thresh: int = 128, dilate_px: int = 2) -> np.ndarray:
    H, W = img_bgr.shape[:2]
    mask = np.zeros((H, W), np.uint8)
    for b in blocks:
        x, y, w, h = _ints(b.bbox)
        m = block_text_mask(img_bgr, b.bbox, dark_thresh)
        region = mask[y:y + h, x:x + w]
        mask[y:y + h, x:x + w] = np.maximum(region, m)
    if dilate_px > 0:
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * dilate_px + 1, 2 * dilate_px + 1))
        mask = cv2.dilate(mask, k)
    return mask


def annotate_style(img_bgr: np.ndarray, block: Block, dark_thresh: int = 128) -> Block:
    """Fill font_px/color/align on `block` in place from its pixels; returns the same block."""
    m = block_text_mask(img_bgr, block.bbox, dark_thresh)
    block.font_px = estimate_font_px(m)
    block.color = estimate_color(img_bgr, block.bbox, m)
    block.align = estimate_align(m, int(round(block.bbox[2])))
    return block
