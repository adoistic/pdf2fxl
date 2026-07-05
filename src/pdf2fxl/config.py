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
    max_block_span: float = 0.9                   # drop OCR blocks spanning more than this fraction of the page in BOTH dimensions (degenerate full-page catch-alls)
    trim_strategy: str = "auto"                   # "auto" (trimbox, else content) | "trimbox" | "content" | "none"
    mode: str = "fxl"                              # "fxl" | "reflow"
    reflow_formats: Tuple[str, ...] = ("epub", "md", "docx")
    reflow_tables: str = "html"                    # "html" | "image"
    reflow_figures: str = "image"                  # "image" | "drop"
    reflow_formulas: str = "image"                 # "mathml" | "image" | "text"
    reflow_layout: str = "auto"                    # "single" | "two-up" | "auto"
    promote_runins: bool = False
    font_map: Dict[str, str] = field(default_factory=_default_font_map)
    pptx_aspect: Tuple[int, int] = (4, 3)         # deck aspect ratio (w, h)
