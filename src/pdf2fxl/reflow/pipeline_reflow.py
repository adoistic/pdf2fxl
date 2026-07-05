from __future__ import annotations
from pathlib import Path
from typing import Callable, List, Optional
import cv2

from ..config import Config
from ..ingest import rasterize_page, trim_page, page_count, trimbox_px
from .ocr_reflow import parse_ocr_reflow
from .assemble import build_doc, PageInput, ReflowOptions
from .render_md import render_markdown
from .render_docx import render_docx
from .render_epub_reflow import write_epub_reflow

OcrFn = Callable[..., dict]


def _trim(img, cfg: Config, pdf_path: str, index: int):
    if cfg.trim_strategy == "none":
        return img
    box = None
    if cfg.trim_strategy in ("auto", "trimbox"):
        box = trimbox_px(pdf_path, index, cfg.zoom)
    return trim_page(img, trim=box)


def convert_book_reflow(pdf_path: str, out_dir: Path, cfg: Optional[Config] = None,
                        ocr_fn: Optional[OcrFn] = None, api_key: str = "",
                        title: str = "Untitled", language: str = "en",
                        font_path: str = "assets/fonts/NotoSerif-Regular.ttf"
                        ) -> List[Path]:
    cfg = cfg or Config(mode="reflow")
    ocr_fn = ocr_fn or __import__("pdf2fxl.ocr", fromlist=["run_ocr"]).run_ocr
    out_dir = Path(out_dir); out_dir.mkdir(parents=True, exist_ok=True)
    images_dir = out_dir / "images"; images_dir.mkdir(parents=True, exist_ok=True)

    page_inputs: List[PageInput] = []
    for i in range(page_count(pdf_path)):
        raw = rasterize_page(pdf_path, i, cfg.zoom)
        img = _trim(raw, cfg, pdf_path, i)
        h, w = img.shape[:2]
        resp = ocr_fn(img, cfg, api_key)
        segs = parse_ocr_reflow(resp, (w, h))
        page_inputs.append(PageInput(image_bgr=img, page_size=(w, h), segments=segs))

    options = ReflowOptions(layout=cfg.reflow_layout, tables=cfg.reflow_tables,
                            figures=cfg.reflow_figures)
    doc = build_doc(page_inputs, title=title, language=language,
                    assets_dir=images_dir, options=options)
    (out_dir / f"{title}.doc.json").write_text(doc.to_json(), encoding="utf-8")

    outputs: List[Path] = []
    if "md" in cfg.reflow_formats:
        p = out_dir / f"{title}.md"; p.write_text(render_markdown(doc), encoding="utf-8")
        outputs.append(p)
    if "docx" in cfg.reflow_formats:
        outputs.append(render_docx(doc, out_dir / f"{title}.docx", assets_root=images_dir))
    if "epub" in cfg.reflow_formats:
        outputs.append(write_epub_reflow(doc, out_dir / f"{title}.epub",
                                         font_path=font_path, assets_root=images_dir))
    return outputs
