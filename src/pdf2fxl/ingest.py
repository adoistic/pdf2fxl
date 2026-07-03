from __future__ import annotations
from typing import Optional, Tuple
import cv2
import numpy as np


def content_bbox(img_bgr: np.ndarray, white_thresh: int = 245,
                 open_ksize: int = 15) -> Tuple[int, int, int, int]:
    """Largest non-white region after morphological opening (drops thin crop marks/slug)."""
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    nonwhite = (gray < white_thresh).astype(np.uint8) * 255
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (open_ksize, open_ksize))
    opened = cv2.morphologyEx(nonwhite, cv2.MORPH_OPEN, kernel)
    n, _, stats, _ = cv2.connectedComponentsWithStats(opened, connectivity=8)
    if n <= 1:
        return (0, 0, img_bgr.shape[1], img_bgr.shape[0])
    i = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    x = int(stats[i, cv2.CC_STAT_LEFT]); y = int(stats[i, cv2.CC_STAT_TOP])
    w = int(stats[i, cv2.CC_STAT_WIDTH]); h = int(stats[i, cv2.CC_STAT_HEIGHT])
    return (x, y, x + w, y + h)


def trim_page(img_bgr: np.ndarray,
              trim: Optional[Tuple[int, int, int, int]]) -> np.ndarray:
    if trim is None:
        trim = content_bbox(img_bgr)
    x0, y0, x1, y1 = trim
    return img_bgr[y0:y1, x0:x1].copy()


def rasterize_page(pdf_path: str, index: int, zoom: float) -> np.ndarray:
    """Render one PDF page to a BGR uint8 array at the given zoom."""
    import fitz
    doc = fitz.open(pdf_path)
    try:
        pix = doc[index].get_pixmap(
            matrix=fitz.Matrix(zoom, zoom),
            colorspace=fitz.csRGB,   # force 3-channel RGB regardless of PDF colorspace (CMYK-safe)
            alpha=False,
        )
        buf = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, pix.n)
        return cv2.cvtColor(buf, cv2.COLOR_RGB2BGR)
    finally:
        doc.close()


def page_count(pdf_path: str) -> int:
    import fitz
    doc = fitz.open(pdf_path)
    try:
        return doc.page_count
    finally:
        doc.close()


def trimbox_px(pdf_path: str, index: int, zoom: float
               ) -> Optional[Tuple[int, int, int, int]]:
    """The page's TrimBox in raster pixel coords, or None if there is none.

    Print-ready PDFs (InDesign exports) carry an exact TrimBox — the printed
    page inside the crop marks. Cropping to it is deterministic and beats any
    content heuristic (which can cut off e.g. a cover title floating on white).
    Returns None when the TrimBox doesn't shrink the MediaBox.

    PDF box coordinates have a bottom-left origin while raster rows grow
    downward, so vertical offsets are flipped against the MediaBox top.
    """
    import fitz
    doc = fitz.open(pdf_path)
    try:
        page = doc[index]
        tb, mb = page.trimbox, page.mediabox
        if tb == mb:
            return None
        x0 = int(round((tb.x0 - mb.x0) * zoom))
        x1 = int(round((tb.x1 - mb.x0) * zoom))
        y0 = int(round((mb.y1 - tb.y1) * zoom))
        y1 = int(round((mb.y1 - tb.y0) * zoom))
        return (x0, y0, x1, y1)
    finally:
        doc.close()
