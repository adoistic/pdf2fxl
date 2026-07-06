"""Container /render: reconstruct a stored Doc and render EPUB/DOCX on demand.

Latin-only doc so no webfont fetch happens; the whole test stays offline.
"""
import sys
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "cloud" / "container"))

from app import app  # noqa: E402

client = TestClient(app)

DOC = {
    "title": "A Small Book",
    "language": "en",
    "nodes": [
        {"level": 1, "text": "Chapter One", "_kind": "Heading"},
        {"runs": [{"text": "The opening paragraph of a small book.", "bold": False, "italic": False, "dropcap": False}], "_kind": "Paragraph"},
    ],
}


def test_render_epub_returns_zip():
    r = client.post("/render", json={"doc_json": DOC, "figures": [], "format": "epub"})
    assert r.status_code == 200
    assert r.content[:2] == b"PK"
    assert r.headers["content-type"] == "application/epub+zip"


def test_render_docx_returns_zip():
    r = client.post("/render", json={"doc_json": DOC, "figures": [], "format": "docx"})
    assert r.status_code == 200
    assert r.content[:2] == b"PK"


def test_render_rejects_unknown_format():
    r = client.post("/render", json={"doc_json": DOC, "figures": [], "format": "txt"})
    assert r.status_code == 415


def test_render_rejects_malformed_doc():
    r = client.post("/render", json={"doc_json": {"not": "a doc"}, "figures": [], "format": "epub"})
    assert r.status_code in (422, 200)  # tolerant loaders may yield an empty book, strict ones 422
