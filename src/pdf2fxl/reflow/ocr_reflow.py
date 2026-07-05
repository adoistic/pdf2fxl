from __future__ import annotations
from typing import List, Tuple
import re

from .segment import Segment

# Kept for reflow. page_number/header/footer are kept here too and removed later
# by layout.strip_running (position + cross-page repetition), not blanket-dropped.
_KEEP = frozenset({"text", "title", "section_header", "heading", "list",
                   "caption", "table", "image", "page_number", "header", "footer"})


def _clean_reflow(s: str) -> str:
    s = (s or "").strip()
    s = re.sub(r"^#{1,6}\s*", "", s)     # leading markdown heading marker
    s = re.sub(r"^[-*>]\s+", "", s)      # leading list/quote marker
    # collapse spaces/tabs but PRESERVE newlines (line count feeds size math)
    s = re.sub(r"[ \t]{2,}", " ", s)
    s = re.sub(r"[ \t]*\n[ \t]*", "\n", s)
    return s.strip()


def parse_ocr_reflow(resp: dict, page_size_px: Tuple[int, int]) -> List[Segment]:
    page = resp["pages"][0]
    dims = page["dimensions"]
    sx = page_size_px[0] / dims["width"]
    sy = page_size_px[1] / dims["height"]
    segs: List[Segment] = []
    for b in page.get("blocks", []):
        t = b.get("type", "text")
        if t not in _KEEP:
            continue
        x0 = b["top_left_x"] * sx; y0 = b["top_left_y"] * sy
        x1 = b["bottom_right_x"] * sx; y1 = b["bottom_right_y"] * sy
        text = _clean_reflow(b.get("content", ""))
        if t not in ("image", "table") and not text:
            continue
        segs.append(Segment(page_index=0, type=t,
                            bbox=(x0, y0, x1 - x0, y1 - y0), text=text))
    return segs
