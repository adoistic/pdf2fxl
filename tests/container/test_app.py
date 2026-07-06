import io

import pymupdf
import pytest
from fastapi.testclient import TestClient

from cloud.container.app import app

client = TestClient(app)


def make_pdf(pages: int) -> bytes:
    doc = pymupdf.open()
    for _ in range(pages):
        doc.new_page(width=300, height=400)
    return doc.tobytes()


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"ok": True}


def test_prepare_counts_pages():
    r = client.post(
        "/prepare",
        content=make_pdf(7),
        headers={"content-type": "application/pdf"},
    )
    assert r.status_code == 200
    assert r.json() == {"page_count": 7}


def test_prepare_rejects_garbage():
    r = client.post("/prepare", content=b"not a pdf")
    assert r.status_code == 422
    assert "detail" in r.json()
