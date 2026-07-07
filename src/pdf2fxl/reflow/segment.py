from __future__ import annotations
from dataclasses import dataclass
from typing import Tuple

# Mistral OCR block types treated as headings (level computed by us, not Mistral).
HEADING_TYPES = frozenset({"title", "section_header", "heading"})


def is_heading_type(block_type: str) -> bool:
    return block_type in HEADING_TYPES


@dataclass
class Segment:
    """One OCR block threaded through the reflow pipeline. Fields are filled in
    stages: OCR sets type/bbox/text; typesize sets size_px/n_lines/bold/centered;
    layout sets column/order and drops running heads; hierarchy sets level."""
    page_index: int
    type: str                                  # raw Mistral block type
    bbox: Tuple[float, float, float, float]    # x, y, w, h px on the page
    text: str
    size_px: float = 0.0                       # median band thickness (legacy; body_size + dropcap)
    n_lines: int = 1
    bold: bool = False
    centered: bool = False
    line_px: float = 0.0                        # content-invariant size proxy (line pitch);
                                                # filled by finalize_line_sizes. size_px is left
                                                # as median band thickness for body_size/dropcap.
    ink_left: float = 0.0                       # absolute x of leftmost ink column (page px)
    ink_right: float = 0.0                      # absolute x of rightmost ink column (page px)
    _pitch_px: float = 0.0                      # internal: median line pitch (0 if single-line)
    _band_px: float = 0.0                       # internal: median x-height-core thickness
    column: int = 0                            # 0-based reading column
    order: int = 0                             # global reading order
    level: int = 0                             # heading level 1..6; 0 = not a heading
