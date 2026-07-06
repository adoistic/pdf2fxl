from itertools import count

import pymupdf
import pytest
from fastapi.testclient import TestClient

import cloud.container.app as appmod
from cloud.container.app import app

client = TestClient(app)

# Captured before the autouse _patch_ocr fixture replaces it, so a test can
# exercise the genuine OCR wrapper (its request kwargs) rather than the fake.
_REAL_PROCESS_OCR = appmod._process_ocr


def make_pdf(pages: int) -> bytes:
    """A synthetic PDF with real text so rasterize+OCR have something to chew on."""
    doc = pymupdf.open()
    for i in range(pages):
        page = doc.new_page(width=612, height=792)
        page.insert_text((72, 100), f"Chapter {i + 1}", fontsize=28)
        page.insert_text((72, 160), f"Body text on page {i + 1}.", fontsize=12)
    return doc.tobytes()


def _fake_block(x0, y0, x1, y1, content, btype):
    return {
        "top_left_x": x0,
        "top_left_y": y0,
        "bottom_right_x": x1,
        "bottom_right_y": y1,
        "content": content,
        "type": btype,
    }


def make_fake_ocr():
    """A block-shaped response per page. Distinct heading text per page so the
    engine keeps them as Heading nodes rather than stripping a repeated running
    head (cross-page repetition is treated as a running header by design)."""
    pages = count()

    def fake_ocr(image_bgr, cfg, api_key):
        h, w = image_bgr.shape[:2]
        n = next(pages)
        return {
            "pages": [
                {
                    "index": 0,
                    "markdown": f"# Heading {n}\n\nSome paragraph text {n}.",
                    "dimensions": {"width": w, "height": h, "dpi": 200},
                    "blocks": [
                        _fake_block(100, 100, w - 100, 180, f"Heading {n}", "title"),
                        _fake_block(100, 220, w - 100, 320,
                                    f"Some paragraph text {n}.", "text"),
                    ],
                }
            ]
        }

    return fake_ocr


@pytest.fixture(autouse=True)
def _patch_ocr(monkeypatch):
    # Mock at the boundary of OUR ocr wrapper: no network, no key needed.
    # The real parse_ocr_reflow + build_doc still run.
    monkeypatch.setattr(appmod, "_process_ocr", make_fake_ocr())


def test_process_returns_artifacts():
    r = client.post(
        "/process?mode=reflow&title=SampleBook",
        content=make_pdf(3),
        headers={"content-type": "application/pdf", "x-mistral-key": "test-key"},
    )
    assert r.status_code == 200, r.text
    body = r.json()

    assert body["page_count"] == 3

    assert isinstance(body["doc_json"], dict)
    assert body["doc_json"].get("nodes")

    assert isinstance(body["markdown"], str)
    assert body["markdown"].strip()
    assert "Heading 0" in body["markdown"]
    # the distinct per-page headings survive as Heading nodes
    kinds = [n.get("_kind") for n in body["doc_json"]["nodes"]]
    assert "Heading" in kinds

    assert isinstance(body["verbatim"], list)
    assert len(body["verbatim"]) == 3

    assert isinstance(body["figures"], list)


def test_process_reads_input_url(monkeypatch):
    """When ?input_url is given, the app fetches the PDF from that url (a presigned
    R2 GET) instead of the request body, then processes normally."""
    pdf = make_pdf(2)

    class _Resp:
        content = pdf

        def raise_for_status(self):
            return None

    seen = {}

    def fake_get(url, *args, **kwargs):
        seen["url"] = url
        return _Resp()

    monkeypatch.setattr(appmod.httpx, "get", fake_get)

    r = client.post(
        "/process?mode=reflow&title=FromUrl&input_url=https://r2.example/presigned",
        # No body: the app must fetch from input_url.
        headers={"x-mistral-key": "test-key"},
    )
    assert r.status_code == 200, r.text
    assert seen["url"] == "https://r2.example/presigned"
    body = r.json()
    assert body["page_count"] == 2
    assert isinstance(body["doc_json"], dict)
    assert body["doc_json"].get("nodes")


def test_process_rejects_garbage():
    r = client.post(
        "/process?mode=reflow&title=Bad",
        content=b"not a pdf",
        headers={"x-mistral-key": "test-key"},
    )
    assert r.status_code == 422
    assert "detail" in r.json()
    # never leak the key or internal traces
    assert "test-key" not in r.text


def test_process_ocr_requests_html_tables(monkeypatch):
    """The realtime OCR call must ask Mistral for HTML tables. Without
    table_format='html' the block content is markdown pipes, which render as
    literal '| --- |' text in the EPUB. Assert the kwarg is passed."""
    captured = {}

    class FakeOCR:
        def process(self, **kwargs):
            captured.update(kwargs)

            class R:
                def model_dump(self_inner):
                    return {"pages": [{"dimensions": {"width": 10, "height": 10},
                                       "blocks": []}]}
            return R()

    class FakeClient:
        def __init__(self, api_key=None):
            self.ocr = FakeOCR()

    monkeypatch.setattr("mistralai.client.Mistral", FakeClient, raising=False)
    import numpy as np
    _REAL_PROCESS_OCR(np.zeros((10, 10, 3), dtype=np.uint8), appmod.Config(mode="reflow"), "k")
    assert captured.get("table_format") == "html"
    assert captured.get("include_blocks") is True
