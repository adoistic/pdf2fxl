from __future__ import annotations
from pathlib import Path
from typing import Callable, List, Optional, Tuple
import cv2

from .config import Config
from .fittext import fit_font_px
from .models import Page
from .ingest import rasterize_page, trim_page, page_count
from .ocr import parse_ocr_response, run_ocr
from .textmask import annotate_style, build_page_mask
from .inpaint import apply_inpainting, Inpainter, LamaInpainter
from .render_epub import write_epub
from .render_pptx import write_pptx

OcrFn = Callable[..., dict]


def _trim(img, cfg: Config):
    if cfg.trim_strategy == "none":
        return img
    return trim_page(img, trim=None)   # content-based trim


def convert_page(pdf_path: str, index: int, out_dir: Path, cfg: Config,
                 ocr_fn: OcrFn, inpainter: Inpainter, api_key: str,
                 font_path: str = "assets/fonts/NotoSerif-Regular.ttf") -> Page:
    pages_dir = out_dir / "pages"; pages_dir.mkdir(parents=True, exist_ok=True)
    raw = rasterize_page(pdf_path, index, cfg.zoom)
    img = _trim(raw, cfg)
    h, w = img.shape[:2]

    resp = ocr_fn(img, cfg, api_key)
    blocks = parse_ocr_response(resp, (w, h), cfg)
    for b in blocks:
        annotate_style(img, b, cfg.dark_thresh)   # color + align from pixels
        # Font size is solved, not estimated: largest size whose wrapped text
        # provably fits the block box when measured with the embedded font.
        b.font_px = fit_font_px(b.text, b.bbox[2], b.bbox[3], font_path)

    mask = build_page_mask(img, blocks, cfg.dark_thresh, cfg.mask_dilate_px)
    clean = apply_inpainting(img, mask, inpainter)

    orig_path = pages_dir / f"page-{index:02d}.png"
    clean_path = pages_dir / f"page-{index:02d}-clean.png"
    cv2.imwrite(str(orig_path), img)
    cv2.imwrite(str(clean_path), clean)

    page = Page(index=index, page_size_px=(w, h), background=str(clean_path),
                original=str(orig_path), blocks=blocks)
    (pages_dir / f"page-{index:02d}.json").write_text(page.to_json(), encoding="utf-8")
    return page


def convert_book(pdf_path: str, out_dir: Path, cfg: Optional[Config] = None,
                 ocr_fn: Optional[OcrFn] = None, inpainter: Optional[Inpainter] = None,
                 api_key: str = "", title: str = "Untitled", language: str = "en",
                 font_path: str = "assets/fonts/NotoSerif-Regular.ttf"
                 ) -> Tuple[Path, Path]:
    cfg = cfg or Config()
    ocr_fn = ocr_fn or run_ocr
    inpainter = inpainter or LamaInpainter()
    out_dir = Path(out_dir); out_dir.mkdir(parents=True, exist_ok=True)

    pages: List[Page] = [
        convert_page(pdf_path, i, out_dir, cfg, ocr_fn, inpainter, api_key,
                     font_path=font_path)
        for i in range(page_count(pdf_path))
    ]

    epub = out_dir / f"{title}.epub"
    pptx = out_dir / f"{title}.pptx"
    write_epub(pages, epub, title=title, language=language, font_path=font_path)
    write_pptx(pages, pptx, aspect=cfg.pptx_aspect, font_name=cfg.font_map["Latn"])
    return epub, pptx
