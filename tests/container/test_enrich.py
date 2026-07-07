"""Emphasis enrichment: pure-function correctness + one integration pass.

No network: the OpenRouter call is stubbed. The gate/parse/align/split functions
are exercised directly; the integration test drives them through /process with a
fake OCR and a fake model.
"""
from itertools import count

import pymupdf
import pytest
from fastapi.testclient import TestClient

import cloud.container.app as appmod
import cloud.container.enrich as en
from cloud.container.app import app

client = TestClient(app)


# --------------------------------------------------------------------------- #
# parse_emphasis / emphasized_spans
# --------------------------------------------------------------------------- #
def test_parse_simple_bold():
    spans = en.emphasized_spans("hello <b>world</b>", "hello world")
    assert spans == [(6, 11, frozenset({"bold"}))]


def test_parse_nested_bold_italic():
    # "<b>a<i>b</i></b>" over "ab": char0 bold, char1 bold+italic.
    spans = en.emphasized_spans("<b>a<i>b</i></b>", "ab")
    assert spans == [(0, 1, frozenset({"bold"})),
                     (1, 2, frozenset({"bold", "italic"}))]


def test_parse_underline_and_synonyms():
    assert en.emphasized_spans("<u>x</u>", "x") == [(0, 1, frozenset({"underline"}))]
    assert en.emphasized_spans("<strong>x</strong>", "x") == [(0, 1, frozenset({"bold"}))]
    assert en.emphasized_spans("<EM>x</EM>", "x") == [(0, 1, frozenset({"italic"}))]


@pytest.mark.parametrize("returned,original", [
    ("hello WORLD", "hello world"),          # changed a word
    ("hello", "hello world"),                # dropped text
    ("hello  world", "hello world"),         # reflowed whitespace
    ("AT&amp;T", "AT&T"),                    # HTML entity (escaping)
    ("<x>hi</x>", "hi"),                      # unrecognized tag becomes literal -> mismatch
    ("</b>hi", "hi"),                         # close without open
    ("<b>hi", "hi"),                          # unclosed
])
def test_gate_rejects_any_deviation(returned, original):
    assert en.emphasized_spans(returned, original) is None


def test_bare_ampersand_and_lt_pass_through():
    # A literal & or < that is NOT a recognized tag/entity must pass verbatim.
    assert en.emphasized_spans("a & b", "a & b") == []
    assert en.emphasized_spans("a < b", "a < b") == []


# --------------------------------------------------------------------------- #
# doc stream, apply, run rebuild
# --------------------------------------------------------------------------- #
def _para(text, **style):
    return {"_kind": "Paragraph",
            "runs": [{"text": text, "bold": style.get("bold", False),
                      "italic": style.get("italic", False),
                      "underline": style.get("underline", False), "dropcap": False}]}


def _run_text(node):
    return "".join(r["text"] for r in node["runs"])


def test_apply_splits_run_and_sets_style():
    doc = {"nodes": [_para("the quick brown fox")]}
    stream, owners = en.build_doc_stream(doc)
    added = {}
    # emphasize "quick" (chars 4..9) italic
    en.apply_page_spans(stream, owners, 0, ["the quick brown fox"],
                        [[(4, 9, frozenset({"italic"}))]], added)
    for p, node in en._paragraphs(doc):
        en._rebuild_paragraph(node, added, p)
    node = doc["nodes"][0]
    assert _run_text(node) == "the quick brown fox"        # text preserved
    italic_runs = [r for r in node["runs"] if r["italic"]]
    assert [r["text"] for r in italic_runs] == ["quick"]


def test_existing_bold_is_preserved_when_split():
    # A run that is already bold, split by an italic span, stays bold everywhere.
    doc = {"nodes": [_para("alpha beta", bold=True)]}
    stream, owners = en.build_doc_stream(doc)
    added = {}
    en.apply_page_spans(stream, owners, 0, ["alpha beta"],
                        [[(6, 10, frozenset({"italic"}))]], added)
    node = doc["nodes"][0]
    en._rebuild_paragraph(node, added, 0)
    assert _run_text(node) == "alpha beta"
    assert all(r["bold"] for r in node["runs"])            # bold never cleared
    ital = [r["text"] for r in node["runs"] if r["italic"]]
    assert ital == ["beta"]


def test_enrich_doc_json_end_to_end_pure():
    doc = {"nodes": [_para("Some paragraph text here.")]}
    verbatim = [{"pages": [{"blocks": [
        {"type": "text", "content": "Some paragraph text here."}]}]}]

    def fake_model(_img, blocks, **_kw):
        return [b.replace("paragraph", "<b>paragraph</b>") for b in blocks]

    total, enriched, changed = en.enrich_doc_json(
        doc, verbatim, lambda i: b"PNG", fake_model, model="m", api_key="k")
    assert (total, enriched, changed) == (1, 1, True)
    node = doc["nodes"][0]
    assert _run_text(node) == "Some paragraph text here."
    bold = [r["text"] for r in node["runs"] if r["bold"]]
    assert bold == ["paragraph"]


def test_enrich_skips_block_that_fails_gate_but_page_still_billed():
    doc = {"nodes": [_para("Some paragraph text here.")]}
    verbatim = [{"pages": [{"blocks": [
        {"type": "text", "content": "Some paragraph text here."}]}]}]

    def altering_model(_img, blocks, **_kw):
        return [b.upper() for b in blocks]     # changes text -> gate fails

    total, enriched, changed = en.enrich_doc_json(
        doc, verbatim, lambda i: b"PNG", altering_model, model="m", api_key="k")
    assert (total, enriched, changed) == (1, 1, False)     # call ok -> page billed
    assert _run_text(doc["nodes"][0]) == "Some paragraph text here."
    assert not any(r["bold"] for r in doc["nodes"][0]["runs"])


def test_enrich_page_call_error_is_not_billed():
    doc = {"nodes": [_para("Body text.")]}
    verbatim = [{"pages": [{"blocks": [{"type": "text", "content": "Body text."}]}]}]

    def boom(_img, blocks, **_kw):
        raise RuntimeError("openrouter down")

    total, enriched, changed = en.enrich_doc_json(
        doc, verbatim, lambda i: b"PNG", boom, model="m", api_key="k")
    assert (total, enriched, changed) == (1, 0, False)     # errored -> refunded


# --------------------------------------------------------------------------- #
# Integration through /process
# --------------------------------------------------------------------------- #
def make_pdf(pages: int) -> bytes:
    doc = pymupdf.open()
    for i in range(pages):
        page = doc.new_page(width=612, height=792)
        page.insert_text((72, 100), f"Chapter {i + 1}", fontsize=28)
        page.insert_text((72, 160), f"Body text on page {i + 1}.", fontsize=12)
    return doc.tobytes()


def _fake_ocr():
    pages = count()

    def fake(image_bgr, cfg, api_key):
        h, w = image_bgr.shape[:2]
        n = next(pages)
        return {"pages": [{
            "index": 0,
            "markdown": f"# Heading {n}\n\nSome paragraph text {n}.",
            "dimensions": {"width": w, "height": h, "dpi": 200},
            "blocks": [
                {"top_left_x": 100, "top_left_y": 100, "bottom_right_x": w - 100,
                 "bottom_right_y": 180, "content": f"Heading {n}", "type": "title"},
                {"top_left_x": 100, "top_left_y": 220, "bottom_right_x": w - 100,
                 "bottom_right_y": 320, "content": f"Some paragraph text {n}.",
                 "type": "text"},
            ],
        }]}

    return fake


@pytest.fixture(autouse=True)
def _patch_ocr(monkeypatch):
    monkeypatch.setattr(appmod, "_process_ocr", _fake_ocr())


def _post(qs, enrich_headers=True):
    headers = {"content-type": "application/pdf", "x-mistral-key": "mk"}
    if enrich_headers:
        headers["x-openrouter-key"] = "ork"
    return client.post(qs, content=make_pdf(2), headers=headers)


def test_process_enrich_applies_emphasis(monkeypatch):
    def fake_model(_img, blocks, **_kw):
        return [b.replace("paragraph", "<b>paragraph</b>") for b in blocks]
    monkeypatch.setattr(appmod.enrich, "openrouter_emphasis", fake_model)

    r = _post("/process?mode=reflow&title=B&enrich=1&enrich_model=test")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["enrich"] == {"requested": True, "pages_total": 2, "pages_enriched": 2}

    paras = [n for n in body["doc_json"]["nodes"] if n["_kind"] == "Paragraph"]
    assert paras
    for node in paras:
        assert "".join(r["text"] for r in node["runs"]).startswith("Some paragraph text")
    bolded = [r["text"] for node in paras for r in node["runs"] if r["bold"]]
    assert "paragraph" in bolded
    # markdown re-rendered with the recovered emphasis
    assert "**paragraph**" in body["markdown"]


def test_process_without_enrich_is_untouched(monkeypatch):
    called = {"n": 0}

    def spy(_img, blocks, **_kw):
        called["n"] += 1
        return blocks
    monkeypatch.setattr(appmod.enrich, "openrouter_emphasis", spy)

    r = _post("/process?mode=reflow&title=B", enrich_headers=False)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["enrich"]["requested"] is False
    assert called["n"] == 0                                # never called the model
    paras = [n for n in body["doc_json"]["nodes"] if n["_kind"] == "Paragraph"]
    assert not any(r["bold"] for node in paras for r in node["runs"])
