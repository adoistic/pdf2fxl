from __future__ import annotations
from typing import List, Tuple
import base64
import cv2
import numpy as np

from .models import Block
from .config import Config


def parse_ocr_response(resp: dict, page_size_px: Tuple[int, int],
                       cfg: Config) -> List[Block]:
    """Convert a Mistral OCR-4 response into ordered, filtered Blocks with pixel bboxes."""
    page = resp["pages"][0]
    dims = page["dimensions"]
    sx = page_size_px[0] / dims["width"]
    sy = page_size_px[1] / dims["height"]
    blocks: List[Block] = []
    order = 0
    for b in page.get("blocks", []):
        t = b.get("type", "text")
        if t in cfg.drop_block_types:
            continue
        if cfg.keep_block_types and t not in cfg.keep_block_types:
            continue
        x0 = b["top_left_x"] * sx; y0 = b["top_left_y"] * sy
        x1 = b["bottom_right_x"] * sx; y1 = b["bottom_right_y"] * sy
        blocks.append(Block(
            type=t, bbox=(x0, y0, x1 - x0, y1 - y0),
            text=(b.get("content") or "").strip(),
            reading_order=order, confidence=float(b.get("confidence", 1.0)),
        ))
        order += 1
    return blocks


def run_ocr(image_bgr: np.ndarray, cfg: Config, api_key: str) -> dict:
    """Send one page image to Mistral OCR 4 and return the raw response as a dict.

    NOTE: OCR-4 kwargs (include_blocks, extract_footer) are passed defensively;
    confirm exact names against the installed SDK on first run.
    """
    from mistralai.client import Mistral
    ok, png = cv2.imencode(".png", image_bgr)
    if not ok:
        raise RuntimeError("failed to PNG-encode page image")
    data_url = "data:image/png;base64," + base64.b64encode(png.tobytes()).decode()
    client = Mistral(api_key=api_key)
    resp = client.ocr.process(
        model=cfg.ocr_model,
        document={"type": "image_url", "image_url": data_url},
        include_blocks=True,
        extract_footer=True,
        include_image_base64=False,
    )
    return resp.model_dump() if hasattr(resp, "model_dump") else dict(resp)
