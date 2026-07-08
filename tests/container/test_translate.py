"""Embedded translation engine: corpus routing, guards, splicing, endpoints.

No network: every model call is a stub. The engine's pure pieces (word count,
run/tag bridge, segments, guards) are exercised directly; the endpoint tests
drive /translate and /translate/quote through the FastAPI TestClient.
"""
import json

import pytest
from fastapi.testclient import TestClient

import pdf2fxl.translate.corpus as corpus
import pdf2fxl.translate.engine as en
import pdf2fxl.translate.guards as gd
from cloud.container.app import app

client = TestClient(app)


# --------------------------------------------------------------------------- #
# Word counting (the billing quantity)
# --------------------------------------------------------------------------- #
def test_count_words_plain():
    assert en.count_words("hello world") == 2
    assert en.count_words("   ") == 0


def test_count_words_strips_markdown_syntax():
    md = "## Heading\n\nSome **bold** text with a [link](https://x.y).\n\n| a | b |\n|---|---|\n| c | d |\n"
    # Heading, Some, bold, text, with, a, [link]. + a b c d
    assert en.count_words(md) == 11


def test_count_words_cjk_counts_characters():
    assert en.count_words("中文测试") == 4
    assert en.count_words("hello 中文") == 3


def test_355_words_price_basis():
    assert en.count_words(" ".join(["word"] * 355)) == 355


# --------------------------------------------------------------------------- #
# Corpus routing (progressive disclosure mirrored from the skill)
# --------------------------------------------------------------------------- #
def test_stance_mapping_from_taxonomy():
    assert corpus.stance_for_category("Poetry") == "literary"
    assert corpus.stance_for_category("Academic") == "commercial"
    assert corpus.stance_for_category("Philosophical & Religious") == "literary"
    assert corpus.stance_for_category("nonsense") == "commercial"


def test_guidance_mapping():
    assert corpus.guidance_for_category("Business") is None
    creative = corpus.guidance_for_category("Creative")
    assert creative and "Cultural" in creative.splitlines()[0]


def test_grammar_loaded_only_when_available():
    assert corpus.grammar_for("Hindi")
    assert corpus.grammar_for("hindi ")
    assert corpus.grammar_for("French") is None


def test_colloquial_map_and_script_rules():
    assert "Telugu script" in corpus.colloquial_render_as("Telugu")
    assert corpus.colloquial_render_as("German") is None
    assert corpus.script_rules_for("Urdu")
    assert corpus.script_rules_for("Hindi") is None


def test_prompt_assembly_routes_the_right_corpus():
    p = en.build_system_prompt(
        target_language="Hindi", category="Digital & Marketing",
        stance="commercial", source_language="English", mode="markdown")
    assert "Compound Verbs" in p            # hindi grammar
    assert "Devanagari script" in p          # colloquial render-as (commercial)
    assert "Clarity above all" in p          # commercial stance
    lit = en.build_system_prompt(
        target_language="Hindi", category="Poetry", stance="literary",
        source_language="English", mode="markdown")
    assert "Render the translation as" not in lit   # literary: no colloquial
    assert "Reverence for voice" in lit


# --------------------------------------------------------------------------- #
# Run/tag bridge and document segments
# --------------------------------------------------------------------------- #
def _para(runs):
    return {"_kind": "Paragraph", "runs": runs}


def _doc():
    return {
        "title": "A Book",
        "language": "en",
        "nodes": [
            {"_kind": "Heading", "level": 1, "text": "Chapter One"},
            _para([
                {"text": "It was ", "bold": False, "italic": False,
                 "underline": False, "dropcap": True},
                {"text": "bright", "bold": True, "italic": False,
                 "underline": False, "dropcap": False},
            ]),
            {"_kind": "Figure", "src": "images/img-0.png", "caption": "A map",
             "width_frac": 0.5, "kind": "figure"},
            {"_kind": "Table", "html": "<table><tr><td>cold</td></tr></table>",
             "image_src": None, "caption": "Weather"},
            {"_kind": "Formula", "mathml": None, "text": "E=mc^2",
             "image_src": None, "caption": None},
            {"_kind": "ChapterBreak"},
        ],
    }


def test_tagged_round_trip_preserves_styles_and_dropcap():
    runs = _doc()["nodes"][1]["runs"]
    tagged = en.runs_to_tagged(runs)
    assert tagged == "It was <b>bright</b>"
    back = en.tagged_to_runs(tagged, dropcap=True)
    assert back[0]["dropcap"] and not back[1]["dropcap"]
    assert back[1] == {"text": "bright", "bold": True, "italic": False,
                       "underline": False, "dropcap": False}


def test_malformed_tags_degrade_to_plain_text():
    assert en.tagged_to_runs("<b>oops")[0]["text"] == "oops"
    assert en.tagged_to_runs("</i>x")[0]["text"] == "x"


def test_doc_segments_cover_text_and_skip_formula_bodies():
    segs = en.doc_segments(_doc())
    fields = [(s["node"], s["field"]) for s in segs]
    assert fields == [(-1, "title"), (0, "text"), (1, "runs"),
                      (2, "caption"), (3, "caption"), (3, "html")]


def test_splice_keeps_structure_and_geometry():
    doc = _doc()
    segs = en.doc_segments(doc)
    translated = ["किताब", "अध्याय एक", "यह <b>उज्ज्वल</b> था",
                  "एक नक्शा", "मौसम", "<table><tr><td>ठंडा</td></tr></table>"]
    out, notes = en._splice(doc, segs, translated)
    assert notes == []
    assert out["title"] == "किताब"
    assert out["nodes"][0]["text"] == "अध्याय एक"
    assert out["nodes"][1]["runs"][1]["bold"] is True
    assert out["nodes"][1]["runs"][0]["dropcap"] is True
    assert out["nodes"][2]["src"] == "images/img-0.png"      # geometry untouched
    assert out["nodes"][3]["html"] == "<table><tr><td>ठंडा</td></tr></table>"
    assert out["nodes"][4]["text"] == "E=mc^2"                # formula untouched
    assert doc["nodes"][0]["text"] == "Chapter One"           # input not mutated


def test_splice_rejects_broken_table_markup():
    doc = _doc()
    segs = en.doc_segments(doc)
    translated = ["t", "h", "p", "c", "w", "ठंडा"]  # table lost its tags
    out, notes = en._splice(doc, segs, translated)
    assert out["nodes"][3]["html"] == "<table><tr><td>cold</td></tr></table>"
    assert notes and "markup" in notes[0]


# --------------------------------------------------------------------------- #
# Guards
# --------------------------------------------------------------------------- #
def test_urdu_guard_rejects_any_devanagari():
    issues = gd.check_target_script("Urdu", "یہ ٹھیک ہے लेकिन")
    assert issues and "wrong_script" in issues[0]
    assert gd.check_target_script("Urdu", "یہ بالکل ٹھیک ہے") == []
    assert gd.check_target_script("Hindi", "यह ठीक है") == []


def test_urdu_guard_requires_urdu_script():
    assert gd.check_target_script("Urdu", "all latin output")


def test_numeral_guard_by_value_and_count():
    assert gd.check_numerals("pages 5 and 12", "पृष्ठ 5 और 12") == []
    assert gd.check_numerals("pages 5 and 12", "पृष्ठ पाँच और 12")
    assert gd.check_numerals("5 5", "5")  # count matters


def test_markdown_structure_guard():
    src = "# One\n\n## Two\n\ntext [x](https://a.b)\n"
    ok = "# एक\n\n## दो\n\nपाठ [य](https://a.b)\n"
    assert gd.check_markdown_structure(src, ok) == []
    demoted = "## एक\n\n## दो\n\nपाठ [य](https://a.b)\n"
    assert any("h1" in i for i in gd.check_markdown_structure(src, demoted))
    lost_url = "# एक\n\n## दो\n\nपाठ [य](https://other.c)\n"
    assert any("link url" in i for i in gd.check_markdown_structure(src, lost_url))


# --------------------------------------------------------------------------- #
# Translation paths with a stubbed model
# --------------------------------------------------------------------------- #
DETECT_REPLY = json.dumps({"content_type": "Novel/Book Chapter",
                           "category": "Creative", "source_language": "English"})


def _stub(replies):
    """A model-call stub: detect calls answer with DETECT_REPLY, translation
    calls pop from `replies` in order."""
    calls = []

    def call(messages, *, model, api_key, **kw):
        calls.append(messages)
        if messages[0]["content"].startswith("You classify"):
            return DETECT_REPLY
        return replies.pop(0)

    call.calls = calls
    return call


def test_translate_markdown_happy_path():
    src = "# Title\n\nHello **world**.\n"
    call = _stub(["# शीर्षक\n\nनमस्ते **दुनिया**।\n"])
    out = en.translate_markdown(src, "Hindi", model="m", api_key="k", call=call)
    assert out["markdown"].startswith("# शीर्षक")
    assert out["detection"]["category"] == "Creative"
    assert out["stance"] == "literary"
    assert out["guard"]["passed"] is True
    # system prompt carried the hindi grammar corpus
    assert "Compound Verbs" in call.calls[-1][0]["content"]


def test_translate_markdown_retries_then_fails_on_structure_loss():
    src = "# Title\n\nHello.\n"
    call = _stub(["no heading at all", "still no heading"])
    with pytest.raises(en.TranslationError):
        en.translate_markdown(src, "Hindi", model="m", api_key="k", call=call)
    assert len(call.calls) == 3  # detect + first try + retry


def test_translate_markdown_retry_recovers():
    src = "# Title\n\nHello.\n"
    call = _stub(["missing heading", "# शीर्षक\n\nनमस्ते।\n"])
    out = en.translate_markdown(src, "Hindi", model="m", api_key="k", call=call)
    assert out["markdown"].startswith("# शीर्षक")


def test_translate_doc_happy_path():
    doc = _doc()
    translated = ["किताब", "अध्याय एक", "यह <b>उज्ज्वल</b> था",
                  "एक नक्शा", "मौसम", "<table><tr><td>ठंडा</td></tr></table>"]
    call = _stub([json.dumps(translated, ensure_ascii=False)])
    out = en.translate_doc(doc, "Hindi", model="m", api_key="k", call=call)
    assert out["doc_json"]["nodes"][0]["text"] == "अध्याय एक"
    assert "अध्याय एक" in out["markdown"]
    assert out["guard"]["passed"] is True


def test_translate_doc_shape_failure_raises_after_retry():
    call = _stub(["not json", '["only","two"]'])
    with pytest.raises(en.TranslationError):
        en.translate_doc(_doc(), "Hindi", model="m", api_key="k", call=call)


def test_detect_falls_back_on_garbage():
    def bad_call(messages, **kw):
        raise RuntimeError("down")
    got = en.detect("some text", model="m", api_key="k", call=bad_call)
    assert got == {"content_type": "Other", "category": "Other",
                   "source_language": "unknown"}


# --------------------------------------------------------------------------- #
# Endpoints
# --------------------------------------------------------------------------- #
def test_quote_text_and_doc():
    r = client.post("/translate/quote",
                    json={"kind": "text", "text": "one two three"})
    assert r.status_code == 200 and r.json() == {"word_count": 3}
    r = client.post("/translate/quote", json={"kind": "doc", "doc_json": _doc()})
    assert r.status_code == 200 and r.json()["word_count"] > 0
    assert client.post("/translate/quote", json={"kind": "x"}).status_code == 422


def test_translate_endpoint_text(monkeypatch):
    call = _stub(["# शीर्षक\n\nनमस्ते।\n"])
    monkeypatch.setattr(en, "call_translate_model", call)
    r = client.post(
        "/translate",
        headers={"x-translate-key": "k"},
        json={"kind": "text", "text": "# Title\n\nHello.\n",
              "target_language": "Hindi", "model": "m"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["markdown"].startswith("# शीर्षक")
    assert body["word_count"] == 2


def test_translate_endpoint_enforces_cap_and_key():
    long_text = " ".join(["word"] * 30)
    r = client.post(
        "/translate", headers={"x-translate-key": "k"},
        json={"kind": "text", "text": long_text, "target_language": "Hindi",
              "model": "m", "max_words": 20},
    )
    assert r.status_code == 413
    r = client.post(
        "/translate",
        json={"kind": "text", "text": "hi", "target_language": "Hindi",
              "model": "m"},
    )
    assert r.status_code == 422
