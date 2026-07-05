"""In-memory conversion jobs for the reflow web console.

Each upload becomes a Job run on a background thread. OCR is the slow phase, so
the job reports real per-page progress by wrapping the OCR function with a counter.
This is a single-process store (fine for a desktop/enterprise-internal tool); swap
for a queue + shared store if you ever run multiple workers.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional
import threading

from ..config import Config
from ..ingest import page_count
from ..ocr import run_ocr
from ..reflow.docmodel import Doc, Heading, Figure, Table

# script -> (font file, language code)
FONTS: Dict[str, tuple] = {
    "Latin": ("NotoSerif-Regular.ttf", "en"),
    "Devanagari": ("NotoSerifDevanagari-Regular.ttf", "hi"),
    "Oriya": ("NotoSerifOriya-Regular.ttf", "or"),
}
_EXT = {"epub": "epub", "md": "md", "docx": "docx"}
_MAX_TOC = 600


def _human_bytes(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1_048_576:
        return f"{n / 1024:.0f} KB"
    return f"{n / 1_048_576:.1f} MB"


@dataclass
class Job:
    id: str
    out_dir: Path
    pdf_path: Path
    title: str
    status: str = "running"          # running | done | error
    stage: str = "ocr"               # ocr | assemble | render | done
    ocr_done: int = 0
    ocr_total: int = 0
    error: Optional[str] = None
    result: Optional[dict] = None

    def public(self) -> dict:
        return {
            "id": self.id, "status": self.status, "stage": self.stage,
            "ocr_done": self.ocr_done, "ocr_total": self.ocr_total,
            "error": self.error, "result": self.result,
        }


class JobStore:
    def __init__(self, fonts_dir: Path):
        self._jobs: Dict[str, Job] = {}
        self._lock = threading.Lock()
        self.fonts_dir = Path(fonts_dir)

    def get(self, job_id: str) -> Optional[Job]:
        return self._jobs.get(job_id)

    def file_path(self, job_id: str, fmt: str) -> Optional[Path]:
        job = self._jobs.get(job_id)
        if not job or not job.result:
            return None
        for d in job.result.get("downloads", []):
            if d["fmt"] == fmt:
                return job.out_dir / d["filename"]
        return None

    def start(self, job_id: str, out_dir: Path, pdf_path: Path, title: str,
              api_key: str, font: str, layout: str, tables: str,
              formats: List[str]) -> Job:
        job = Job(id=job_id, out_dir=Path(out_dir), pdf_path=Path(pdf_path), title=title)
        with self._lock:
            self._jobs[job_id] = job
        t = threading.Thread(target=self._run, daemon=True, kwargs=dict(
            job=job, api_key=api_key, font=font, layout=layout, tables=tables,
            formats=formats))
        t.start()
        return job

    def _run(self, job: Job, api_key: str, font: str, layout: str, tables: str,
             formats: List[str]) -> None:
        from ..reflow.pipeline_reflow import convert_book_reflow  # lazy: engine module
        try:
            font_file, language = FONTS.get(font, FONTS["Latin"])
            font_path = str(self.fonts_dir / font_file)
            try:
                job.ocr_total = page_count(str(job.pdf_path))
            except Exception:
                job.ocr_total = 0

            def counting_ocr(image_bgr, cfg, key):
                resp = run_ocr(image_bgr, cfg, key)
                job.ocr_done += 1
                if job.ocr_total and job.ocr_done >= job.ocr_total:
                    job.stage = "assemble"
                return resp

            cfg = Config(mode="reflow", reflow_layout=layout, reflow_tables=tables,
                         reflow_formats=tuple(formats) or ("epub", "md", "docx"))
            convert_book_reflow(
                str(job.pdf_path), job.out_dir, cfg=cfg, ocr_fn=counting_ocr,
                api_key=api_key, title=job.title, language=language, font_path=font_path)

            job.stage = "render"
            job.result = self._build_result(job, formats)
            job.stage = "done"
            job.status = "done"
        except Exception as exc:  # surface a readable message to the UI
            job.error = _friendly_error(exc)
            job.status = "error"

    def _build_result(self, job: Job, formats: List[str]) -> dict:
        doc_json = job.out_dir / f"{job.title}.doc.json"
        headings: List[Heading] = []
        figures = tables = 0
        if doc_json.exists():
            doc = Doc.from_json(doc_json.read_text(encoding="utf-8"))
            for n in doc.nodes:
                if isinstance(n, Heading):
                    headings.append(n)
                elif isinstance(n, Figure):
                    figures += 1
                elif isinstance(n, Table):
                    tables += 1
        toc = [{"level": h.level, "text": h.text} for h in headings[:_MAX_TOC]]
        downloads = []
        for fmt in formats:
            ext = _EXT.get(fmt)
            if not ext:
                continue
            path = job.out_dir / f"{job.title}.{ext}"
            if path.exists():
                downloads.append({
                    "fmt": fmt, "filename": path.name,
                    "size": _human_bytes(path.stat().st_size),
                    "url": f"/api/jobs/{job.id}/file/{fmt}",
                })
        return {
            "title": job.title,
            "stats": {
                "pages": job.ocr_total or None,
                "headings": len(headings),
                "h1": sum(1 for h in headings if h.level == 1),
                "figures": figures,
            },
            "toc": toc,
            "downloads": downloads,
        }


def _friendly_error(exc: Exception) -> str:
    msg = str(exc) or exc.__class__.__name__
    low = msg.lower()
    if "api" in low and "key" in low:
        return "The Mistral OCR key is missing or invalid. Set MISTRAL_API_KEY and retry."
    if "401" in low or "unauthorized" in low:
        return "Mistral rejected the request (unauthorized). Check MISTRAL_API_KEY."
    if "429" in low or "rate" in low:
        return "Mistral is rate-limiting the request. Wait a moment and retry."
    return msg[:240]
