from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Tuple
import cv2

from .segment import Segment, is_heading_type
from .typesize import measure_segment, detect_weight_centering
from .hierarchy import body_size, assign_levels
from .layout import (detect_columns, strip_running, order_segments,
                     merge_dropcaps, rejoin_paragraphs, clean_headings)
from .crop import crop_region, width_frac, classify_image
from .docmodel import (Doc, Heading, Paragraph, Run, Figure, Table, ChapterBreak)


@dataclass
class PageInput:
    image_bgr: "any"
    page_size: Tuple[int, int]     # (w, h)
    segments: List[Segment]


@dataclass
class ReflowOptions:
    layout: str = "auto"           # single | two-up | auto
    tables: str = "html"           # html | image
    figures: str = "image"         # image | drop


def build_doc(pages: List[PageInput], title: str, language: str,
              assets_dir: Path, options: Optional[ReflowOptions] = None) -> Doc:
    options = options or ReflowOptions()
    assets_dir = Path(assets_dir)
    grays = []
    per_page: List[List[Segment]] = []
    for pi, page in enumerate(pages):
        w, h = page.page_size
        gray = cv2.cvtColor(page.image_bgr, cv2.COLOR_BGR2GRAY)
        grays.append(gray)
        for s in page.segments:
            s.page_index = pi
            if s.type not in ("image", "table"):
                measure_segment(gray, s)
                detect_weight_centering(gray, s, page_width=w)
        detect_columns(page.segments, page_width=w, mode=options.layout)
        per_page.append(page.segments)

    ph = pages[0].page_size[1] if pages else 1000
    per_page = strip_running(per_page, page_height=ph)

    flat: List[Segment] = [s for page in per_page for s in page]
    body_px = body_size(flat)
    clean_headings(flat)   # strip trailing page numbers; demote TOC lines to text
    assign_levels(flat)
    ordered = order_segments(flat)
    ordered = merge_dropcaps(ordered, body_px=body_px)
    ordered = rejoin_paragraphs(ordered)

    nodes: List = []
    img_i = 0
    for s in ordered:
        page = pages[s.page_index]
        w, h = page.page_size
        col_w = w / 2 if any(x.column == 1 for x in per_page[s.page_index]) else w
        if s.type == "image" or (s.type == "table" and options.tables == "image"):
            if s.type == "image" and options.figures == "drop":
                continue
            src = crop_region(page.image_bgr, s.bbox,
                              assets_dir / f"img-{img_i:03d}.png"); img_i += 1
            rel = f"images/{src.name}"
            area = (s.bbox[2] * s.bbox[3]) / (w * h)
            if s.type == "table":
                nodes.append(Table(html=None, image_src=rel, caption=None))
            else:
                nodes.append(Figure(src=rel, caption=None,
                                    width_frac=width_frac(s.bbox[2], col_w),
                                    kind=classify_image(area)))
        elif s.type == "table":
            nodes.append(Table(html=s.text or "<table></table>", image_src=None,
                              caption=None))
        elif is_heading_type(s.type):
            if s.level == 1:
                nodes.append(ChapterBreak())
            nodes.append(Heading(level=max(1, s.level), text=s.text))
        else:
            nodes.append(Paragraph(runs=[Run(text=s.text, bold=s.bold)]))
    return Doc(title=title, language=language, nodes=nodes)
