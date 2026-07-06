"""Internal compute service for Thothica OCR.

Pure compute: no storage, no database, no credentials of its own. The Worker
streams bytes in and persists whatever comes back. Never expose this service
publicly; it is reached only through the Worker's container binding.
"""

import pymupdf
from fastapi import FastAPI, HTTPException, Request

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


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
