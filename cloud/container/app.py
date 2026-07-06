"""Internal compute service for Thothica OCR.

Pure compute: no storage, no database, no credentials of its own. The Worker
streams bytes in and persists whatever comes back. Never expose this service
publicly; it is reached only through the Worker's container binding.
"""

import base64
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from itertools import count
from pathlib import Path

import cv2
import pymupdf
from fastapi import FastAPI, HTTPException, Request

# The reflow engine lives in src/pdf2fxl; import it, never modify it.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))
from pdf2fxl.config import Config  # noqa: E402
from pdf2fxl.ingest import page_count, rasterize_page  # noqa: E402
from pdf2fxl.reflow.pipeline_reflow import _trim  # noqa: E402
from pdf2fxl.reflow.pipeline_reflow import convert_book_reflow  # noqa: E402

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

# Realtime OCR model that returns per-block bounding boxes (proven in the spike).
# The engine's pinned mistral-ocr-4-0 is not what we want here; the batch-capable
# alias with include_blocks gives the geometry the reflow algorithm needs.
_OCR_MODEL = "mistral-ocr-latest"

# Concurrency for per-page realtime OCR. Mistral calls are IO-bound network waits,
# so a thread pool parallelizes them cleanly.
_OCR_CONCURRENCY = 10


def _process_ocr(image_bgr, cfg: Config, api_key: str) -> dict:
    """One realtime OCR call for a single page image, with bounding blocks.

    Mirrors src/pdf2fxl/ocr.py:run_ocr but pins mistral-ocr-latest (the model the
    spike proved returns 16 blocks with bboxes in the rasterized pixel space).
    Patched out in tests so no network or key is required.
    """
    from mistralai.client import Mistral

    ok, png = cv2.imencode(".png", image_bgr)
    if not ok:
        raise RuntimeError("failed to PNG-encode page image")
    data_url = "data:image/png;base64," + base64.b64encode(png.tobytes()).decode()
    client = Mistral(api_key=api_key)
    resp = client.ocr.process(
        model=_OCR_MODEL,
        document={"type": "image_url", "image_url": data_url},
        include_blocks=True,
        include_image_base64=False,
    )
    return resp.model_dump() if hasattr(resp, "model_dump") else dict(resp)


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/prepare")
async def prepare(request: Request) -> dict:
    pdf_bytes = await request.body()
    try:
        doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    except Exception as exc:  # pymupdf raises generic errors on bad input
        raise HTTPException(status_code=422, detail="unreadable pdf") from exc
    try:
        return {"page_count": doc.page_count}
    finally:
        doc.close()


def _ocr_pages_concurrent(pdf_path: str, cfg: Config, api_key: str) -> list:
    """Rasterize+trim every page and OCR them concurrently into a per-page cache.

    Returns a list of raw OCR responses indexed by page. Rasterizing here mirrors
    convert_book_reflow's own loop (rasterize_page + _trim) so the cached response
    matches the image the engine re-derives for that page.
    """
    n = page_count(pdf_path)

    def ocr_one(i: int) -> dict:
        raw = rasterize_page(pdf_path, i, cfg.zoom)
        img = _trim(raw, cfg, pdf_path, i)
        return _process_ocr(img, cfg, api_key)

    with ThreadPoolExecutor(max_workers=_OCR_CONCURRENCY) as pool:
        return list(pool.map(ocr_one, range(n)))


@app.post("/process")
async def process(request: Request) -> dict:
    pdf_bytes = await request.body()
    mode = request.query_params.get("mode", "reflow")
    title = request.query_params.get("title") or "Untitled"
    api_key = request.headers.get("x-mistral-key", "")

    # Validate the PDF up front so garbage returns 422 (not a 500 mid-pipeline).
    try:
        doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
        doc.close()
    except Exception as exc:  # pymupdf raises generic errors on bad input
        raise HTTPException(status_code=422, detail="unreadable pdf") from exc

    cfg = Config(mode=mode)
    # Only Markdown is needed from /process; doc.json is written unconditionally by
    # the engine. EPUB/DOCX render on demand later via /render, so skip them here.
    cfg.reflow_formats = ("md",)

    tmpdir = tempfile.TemporaryDirectory(prefix="thothica-process-")
    try:
        pdf_path = str(Path(tmpdir.name) / "input.pdf")
        Path(pdf_path).write_bytes(pdf_bytes)

        # Pre-OCR every page concurrently, then hand convert_book_reflow a cache
        # reader so its sequential per-page loop consumes the parallel results.
        try:
            verbatim = _ocr_pages_concurrent(pdf_path, cfg, api_key)
        except Exception as exc:  # bad OCR shape / decode / vendor error
            raise HTTPException(status_code=422, detail="ocr failed") from exc

        counter = count()
        cache_ocr = lambda image_bgr, _cfg, _key: verbatim[next(counter)]  # noqa: E731

        out_dir = Path(tmpdir.name) / "out"
        try:
            convert_book_reflow(pdf_path, out_dir, cfg=cfg, ocr_fn=cache_ocr,
                                 api_key=api_key, title=title)
        except Exception as exc:
            raise HTTPException(status_code=422, detail="assembly failed") from exc

        doc_json = _read_json(out_dir / f"{title}.doc.json")
        md_path = out_dir / f"{title}.md"
        markdown = md_path.read_text(encoding="utf-8") if md_path.exists() else ""

        figures = []
        images_dir = out_dir / "images"
        if images_dir.is_dir():
            for f in sorted(images_dir.iterdir()):
                if f.is_file():
                    figures.append({
                        "name": f"images/{f.name}",
                        "base64": base64.b64encode(f.read_bytes()).decode(),
                    })

        return {
            "page_count": len(verbatim),
            "verbatim": verbatim,
            "doc_json": doc_json,
            "markdown": markdown,
            "figures": figures,
        }
    except HTTPException:
        raise
    except Exception as exc:  # never leak the key or an internal trace
        raise HTTPException(status_code=422, detail="processing failed") from exc
    finally:
        tmpdir.cleanup()


def _read_json(path: Path) -> dict:
    import json

    return json.loads(path.read_text(encoding="utf-8"))
