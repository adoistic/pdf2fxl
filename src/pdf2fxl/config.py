from __future__ import annotations
from dataclasses import dataclass, field
from typing import Dict, Tuple


def _default_font_map() -> Dict[str, str]:
    return {"Latn": "Noto Serif"}


@dataclass
class Config:
    zoom: float = 300 / 72                       # render at ~300 DPI
    ocr_model: str = "mistral-ocr-4-0"
    keep_block_types: Tuple[str, ...] = ("text", "title", "list", "caption")
    drop_block_types: Tuple[str, ...] = ("header", "footer", "page_number", "image")
    dark_thresh: int = 128                        # text-pixel threshold (grayscale)
    mask_dilate_px: int = 2
    trim_strategy: str = "content"                # "content" | "trimbox" | "none"
    font_map: Dict[str, str] = field(default_factory=_default_font_map)
    pptx_aspect: Tuple[int, int] = (4, 3)         # deck aspect ratio (w, h)
