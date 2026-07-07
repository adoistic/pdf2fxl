from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Tuple
import cv2

from .segment import Segment, is_heading_type
from .typesize import measure_segment, detect_weight_centering
from .hierarchy import (body_size, assign_levels, finalize_line_sizes,
                        body_line_size)
from .layout import (detect_columns, strip_running, order_segments,
                     merge_dropcaps, rejoin_paragraphs, clean_headings)
from .crop import crop_region, width_frac, classify_image
from .inline_md import parse_inline_md, strip_inline_md
from .docmodel import (Doc, Heading, Paragraph, Run, Figure, Table, ChapterBreak)


def _col_w_of(per_page, pages):
    """Return a callable seg -> column width (page px): half page width when that
    page has a second reading column, else full width. Mirrors build_doc's own
    col_w computation, so heading span is scored against the right measure."""
    two_col = {pi: any(x.column == 1 for x in segs)
               for pi, segs in enumerate(per_page)}

    def _f(s: Segment) -> float:
        w = pages[s.page_index].page_size[0]
        return w / 2 if two_col.get(s.page_index) else w
    return _f


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
    finalize_line_sizes(flat)                 # fill s.line_px (content-invariant size proxy)
    body_px = body_size(flat)                 # UNCHANGED: dropcap uses this (size_px units)
    body_line = body_line_size(flat)          # dominant body line-pitch (line_px units)
    clean_headings(flat)                      # strip page numbers; demote TOC lines BEFORE leveling
    assign_levels(flat, body_px=body_line, col_w_of=_col_w_of(per_page, pages))
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
            nodes.append(Heading(level=max(1, s.level), text=strip_inline_md(s.text)))
        else:
            nodes.append(Paragraph(runs=parse_inline_md(s.text, base_bold=s.bold)))
    return Doc(title=title, language=language, nodes=nodes)
