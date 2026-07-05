"""Thothica Reflow — FastAPI console for scanned-PDF -> reflowable editions.

Run:
    pip install -e '.[web]'
    python -m pdf2fxl.web        # or: uvicorn pdf2fxl.web.app:app --reload
"""
from __future__ import annotations
from pathlib import Path
from typing import List
import os
import re
import tempfile
import uuid

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles

from ..cli import _load_dotenv
from .jobs import JobStore

HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parents[2]                      # src/pdf2fxl/web -> repo root
FONTS_DIR = PROJECT_ROOT / "assets" / "fonts"
STATIC_DIR = HERE / "static"
TEMPLATE = HERE / "templates" / "index.html"
WORK = Path(tempfile.gettempdir()) / "thothica-reflow"
WORK.mkdir(parents=True, exist_ok=True)

_MEDIA = {
    "epub": "application/epub+zip",
    "md": "text/markdown; charset=utf-8",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}
_ALLOWED_FORMATS = ("epub", "md", "docx")

_load_dotenv()
app = FastAPI(title="Thothica Reflow", docs_url=None, redoc_url=None)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
store = JobStore(fonts_dir=FONTS_DIR)


def _api_key() -> str:
    return os.environ.get("MISTRAL_API_KEY", "")


def _safe_title(raw: str, fallback: str) -> str:
    t = re.sub(r"[^\w\- ]+", "", (raw or "").strip())[:80].strip()
    return t or re.sub(r"[^\w\- ]+", "", fallback)[:80].strip() or "Book"


@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    html = TEMPLATE.read_text(encoding="utf-8")
    if _api_key():
        html = html.replace("{{ENGINE_CLASS}}", "").replace("{{ENGINE_LABEL}}", "OCR engine ready")
    else:
        html = html.replace("{{ENGINE_CLASS}}", "off").replace("{{ENGINE_LABEL}}", "Set MISTRAL_API_KEY")
    return HTMLResponse(html)


@app.post("/api/convert")
async def convert(
    file: UploadFile = File(...),
    title: str = Form(""),
    layout: str = Form("auto"),
    tables: str = Form("html"),
    formats: List[str] = Form(default=[]),
) -> JSONResponse:
    if not _api_key():
        raise HTTPException(status_code=400,
                            detail="The Mistral OCR key is not set. Add MISTRAL_API_KEY to the environment or a .env file, then reload.")
    if not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Please upload a PDF file.")

    formats = [f for f in formats if f in _ALLOWED_FORMATS] or list(_ALLOWED_FORMATS)
    layout = layout if layout in ("auto", "single", "two-up") else "auto"
    tables = tables if tables in ("html", "image") else "html"

    job_id = uuid.uuid4().hex[:16]
    out_dir = WORK / job_id
    out_dir.mkdir(parents=True, exist_ok=True)
    pdf_path = out_dir / "source.pdf"
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="The uploaded file was empty.")
    pdf_path.write_bytes(data)

    clean_title = _safe_title(title, Path(file.filename).stem)
    store.start(job_id, out_dir, pdf_path, clean_title, api_key=_api_key(),
                layout=layout, tables=tables, formats=formats)
    return JSONResponse({"id": job_id})


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str) -> JSONResponse:
    job = store.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Unknown job.")
    return JSONResponse(job.public())


@app.get("/api/jobs/{job_id}/file/{fmt}")
def job_file(job_id: str, fmt: str) -> FileResponse:
    path = store.file_path(job_id, fmt)
    if not path or not path.exists():
        raise HTTPException(status_code=404, detail="File not ready.")
    return FileResponse(str(path), filename=path.name,
                        media_type=_MEDIA.get(fmt, "application/octet-stream"))
