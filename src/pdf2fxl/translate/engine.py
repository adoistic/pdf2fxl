"""Translation engine: detection, prompt assembly, model calls, splicing.

Two model calls per job. Call 1 classifies the source against the vendored
taxonomy (content type, category, source language); category resolves to a
stance and an optional guidance file in code, from the taxonomy's own tables.
Call 2 translates: pasted markdown goes through whole (with a strict
format-preservation contract), a stored document goes through as a same-length
JSON array of its translatable segments and is spliced back into an untouched
copy of the structure, so every piece of text keeps its place.

The networked model call is injected everywhere so tests stub it; the real
client lives at the bottom, provider-neutral except one endpoint constant.
"""
from __future__ import annotations

import copy
import json
import re
from typing import Callable, Dict, List, Optional, Tuple

from . import corpus, guards

Messages = List[dict]
ModelCall = Callable[..., str]


class TranslationError(Exception):
    """Public-safe translation failure (guards, model shape, empty input)."""


# --------------------------------------------------------------------------- #
# Word counting (canonical: the Worker prices from this via /translate/quote)
# --------------------------------------------------------------------------- #
_TAG_RE = re.compile(r"<[^>]+>")
_LINK_TARGET = re.compile(r"\]\([^)]*\)")
# Hiragana/Katakana, CJK ideographs (ext A + base), Hangul syllables.
_CJK = re.compile("[\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uac00-\\ud7af]")


def plain_text(text: str) -> str:
    """Markdown/HTML syntax stripped down to the human-readable text."""
    t = _TAG_RE.sub(" ", text)
    t = _LINK_TARGET.sub("]", t)
    lines = []
    for line in t.splitlines():
        s = line.strip()
        if s and set(s) <= set("-|:=. "):
            continue  # table separators / horizontal rules
        s = re.sub(r"^#{1,6}\s+", "", s)
        s = re.sub(r"^>+\s*", "", s)
        s = re.sub(r"^(?:[-*+]|\d+[.)])\s+", "", s)
        s = s.replace("|", " ").replace("*", "").replace("`", "")
        lines.append(s)
    return "\n".join(lines)


def count_words(text: str) -> int:
    """Whitespace-separated words, with CJK counted per character (those
    scripts do not space-separate words and would otherwise underprice)."""
    plain = plain_text(text)
    cjk = len(_CJK.findall(plain))
    rest = _CJK.sub(" ", plain)
    return len(rest.split()) + cjk


# --------------------------------------------------------------------------- #
# Styled-run <-> tagged-text bridge (document segments)
# --------------------------------------------------------------------------- #
_STYLE_TAG = re.compile(r"<\s*(/?)\s*(b|i|u)\s*>", re.IGNORECASE)
_STYLE_OF = {"b": "bold", "i": "italic", "u": "underline"}


def runs_to_tagged(runs: List[dict]) -> str:
    parts = []
    for r in runs:
        t = r.get("text", "")
        if not t:
            continue
        if r.get("underline"):
            t = f"<u>{t}</u>"
        if r.get("italic"):
            t = f"<i>{t}</i>"
        if r.get("bold"):
            t = f"<b>{t}</b>"
        parts.append(t)
    return "".join(parts)


def strip_style_tags(s: str) -> str:
    return _STYLE_TAG.sub("", s)


def tagged_to_runs(tagged: str, dropcap: bool = False) -> List[dict]:
    """Parse <b>/<i>/<u>-tagged text back into run dicts. Malformed tagging
    degrades to one plain run with the tags stripped — text is never lost."""
    counts = {"bold": 0, "italic": 0, "underline": 0}
    chars: List[Tuple[str, frozenset]] = []
    pos = 0
    for m in _STYLE_TAG.finditer(tagged):
        style_now = frozenset(k for k, v in counts.items() if v > 0)
        for ch in tagged[pos:m.start()]:
            chars.append((ch, style_now))
        style = _STYLE_OF[m.group(2).lower()]
        counts[style] += -1 if m.group(1) else 1
        if counts[style] < 0:
            return [{"text": strip_style_tags(tagged), "bold": False,
                     "italic": False, "underline": False, "dropcap": dropcap}]
        pos = m.end()
    style_now = frozenset(k for k, v in counts.items() if v > 0)
    for ch in tagged[pos:]:
        chars.append((ch, style_now))
    if any(v != 0 for v in counts.values()):
        return [{"text": strip_style_tags(tagged), "bold": False,
                 "italic": False, "underline": False, "dropcap": dropcap}]

    runs: List[dict] = []
    i = 0
    while i < len(chars):
        st = chars[i][1]
        j = i
        buf = []
        while j < len(chars) and chars[j][1] == st:
            buf.append(chars[j][0])
            j += 1
        runs.append({
            "text": "".join(buf), "bold": "bold" in st, "italic": "italic" in st,
            "underline": "underline" in st, "dropcap": dropcap if not runs else False,
        })
        i = j
    return runs or [{"text": "", "bold": False, "italic": False,
                     "underline": False, "dropcap": dropcap}]


_HTML_TAG = re.compile(r"<\s*(/?)\s*([a-zA-Z0-9]+)")


def html_tag_signature(html: str) -> List[Tuple[str, str]]:
    return [(c, n.lower()) for c, n in _HTML_TAG.findall(html)]


# --------------------------------------------------------------------------- #
# Document segments
# --------------------------------------------------------------------------- #
def doc_segments(doc_json: dict) -> List[dict]:
    """Every translatable piece of text with its splice-back address. Formula
    bodies, figure sources, and all geometry stay untouched."""
    segs: List[dict] = []
    title = (doc_json.get("title") or "").strip()
    if title:
        segs.append({"node": -1, "field": "title", "text": title})
    for i, node in enumerate(doc_json.get("nodes", [])):
        kind = node.get("_kind")
        if kind == "Heading":
            if (node.get("text") or "").strip():
                segs.append({"node": i, "field": "text", "text": node["text"]})
        elif kind == "Paragraph":
            tagged = runs_to_tagged(node.get("runs", []))
            if tagged.strip():
                segs.append({"node": i, "field": "runs", "text": tagged})
        elif kind in ("Figure", "Table", "Formula"):
            if (node.get("caption") or "").strip():
                segs.append({"node": i, "field": "caption", "text": node["caption"]})
            if kind == "Table" and (node.get("html") or "").strip():
                segs.append({"node": i, "field": "html", "text": node["html"]})
    return segs


def doc_word_count(doc_json: dict) -> int:
    return count_words("\n".join(s["text"] for s in doc_segments(doc_json)))


def _splice(doc_json: dict, segs: List[dict], translated: List[str]) -> Tuple[dict, List[str]]:
    """A new doc with translated text in every segment's place. Table markup
    whose tag structure did not survive keeps the original HTML (noted)."""
    out = copy.deepcopy(doc_json)
    notes: List[str] = []
    for seg, new_text in zip(segs, translated):
        new_text = str(new_text)
        if seg["field"] == "title":
            out["title"] = strip_style_tags(new_text).strip() or out.get("title", "")
            continue
        node = out["nodes"][seg["node"]]
        if seg["field"] == "runs":
            had_dropcap = any(r.get("dropcap") for r in node.get("runs", []))
            node["runs"] = tagged_to_runs(new_text, dropcap=had_dropcap)
        elif seg["field"] == "html":
            if html_tag_signature(new_text) == html_tag_signature(seg["text"]):
                node["html"] = new_text
            else:
                notes.append(f"table at node {seg['node']} kept its original text: "
                             "markup did not survive translation")
        else:
            node[seg["field"]] = strip_style_tags(new_text).strip()
    return out, notes


# --------------------------------------------------------------------------- #
# Detection (model call 1)
# --------------------------------------------------------------------------- #
_DETECT_INSTRUCTION = (
    "You classify source text for a translation pipeline. Use the taxonomy "
    "below. Reply with ONLY a JSON object of the form "
    '{"content_type": string, "category": string, "source_language": string} '
    "where category is exactly one of the taxonomy's category names and "
    "source_language is the English name of the language the text is written "
    "in. No commentary.\n\n"
)


def _extract_json(text: str):
    t = text.strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z]*\n?", "", t)
        t = re.sub(r"\n?```$", "", t).strip()
    try:
        return json.loads(t)
    except Exception:
        for open_ch, close_ch in (("{", "}"), ("[", "]")):
            start, end = t.find(open_ch), t.rfind(close_ch)
            if start != -1 and end > start:
                return json.loads(t[start:end + 1])
        raise ValueError("no JSON in model reply")


def detect(sample: str, *, model: str, api_key: str, call: ModelCall) -> Dict[str, str]:
    fallback = {"content_type": "Other", "category": "Other",
                "source_language": "unknown"}
    try:
        content = call(
            [{"role": "system", "content": _DETECT_INSTRUCTION + corpus.taxonomy()},
             {"role": "user", "content": sample}],
            model=model, api_key=api_key,
        )
        got = _extract_json(content)
        if not isinstance(got, dict):
            return fallback
        category = str(got.get("category", "Other")).strip()
        known = {c.lower() for c in corpus.categories()}
        if category.lower() not in known:
            category = "Other"
        return {
            "content_type": str(got.get("content_type", "Other")).strip() or "Other",
            "category": category,
            "source_language": str(got.get("source_language", "unknown")).strip()
            or "unknown",
        }
    except Exception:
        return fallback


# --------------------------------------------------------------------------- #
# Prompt assembly (model call 2)
# --------------------------------------------------------------------------- #
_MARKDOWN_CONTRACT = """## Format preservation (hard rules)
- Preserve the markdown structure EXACTLY: same heading levels (same number of
  # per heading), same lists and markers, same blockquote nesting, same table
  shape (columns, separator row, alignment markers), same paragraph breaks.
- Preserve inline emphasis markers (** and *) around the corresponding
  translated words.
- NEVER translate content inside code blocks or inline code; keep language
  specifiers.
- Translate link text only; never modify URLs.
- Keep every numeral exactly as written: digits stay digits with the same
  value and format (dates, times, prices, page numbers, percentages).
- Translate the text itself; add no commentary, no notes, no preamble.
Output ONLY the translated document."""

_SEGMENTS_CONTRACT = """## Format preservation (hard rules)
You will receive a JSON array of strings: the text segments of a document in
reading order. Reply with ONLY a JSON array of the same length and order, each
element the translation of the corresponding input element.
- Segments may contain <b>, <i>, <u> tags: keep the tags, wrapped around the
  corresponding translated words. Add no other tags.
- Segments may be HTML table markup: translate ONLY the human-readable text
  inside; keep every tag, attribute, and the exact element structure.
- Keep every numeral exactly as written: digits stay digits with the same
  value and format.
- Never translate URLs or code. Add no commentary."""


def build_system_prompt(*, target_language: str, category: str, stance: str,
                        source_language: str, mode: str) -> str:
    src = source_language if source_language not in ("", "unknown") \
        else "the source language"
    parts = [
        "You are the translation engine of a publishing platform. Translate "
        f"from {src} into {target_language}. The reader must receive a "
        f"faithful, natural {target_language} rendering of the full text.",
        "## Register\n" + corpus.stance_text(stance),
    ]
    guidance = corpus.guidance_for_category(category)
    if guidance:
        parts.append("## Domain guidance\n" + guidance)
    grammar = corpus.grammar_for(target_language)
    if grammar:
        parts.append("## Target-language grammar\n" + grammar)
    if stance == "commercial":
        render_as = corpus.colloquial_render_as(target_language)
        if render_as:
            parts.append("## Register rendering\nRender the translation as: "
                         + render_as + ".")
    script_rules = corpus.script_rules_for(target_language)
    if script_rules:
        parts.append("## Script rules\n" + script_rules)
    parts.append(_MARKDOWN_CONTRACT if mode == "markdown" else _SEGMENTS_CONTRACT)
    return "\n\n".join(parts)


# --------------------------------------------------------------------------- #
# Translation paths
# --------------------------------------------------------------------------- #
def translate_markdown(text: str, target_language: str, *, model: str,
                       api_key: str, call: ModelCall) -> dict:
    """Pasted text/markdown -> translated markdown, guards enforced."""
    if not text.strip():
        raise TranslationError("there is nothing to translate")
    detection = detect(plain_text(text)[:2000], model=model, api_key=api_key,
                       call=call)
    stance = corpus.stance_for_category(detection["category"])
    system = build_system_prompt(
        target_language=target_language, category=detection["category"],
        stance=stance, source_language=detection["source_language"],
        mode="markdown")
    messages: Messages = [{"role": "system", "content": system},
                          {"role": "user", "content": text}]
    out = call(messages, model=model, api_key=api_key)
    report = guards.run_guards(target_language, text, out)
    if report.issues:
        retry = messages + [
            {"role": "assistant", "content": out},
            {"role": "user", "content":
                "Your translation violated these hard formatting rules:\n- "
                + "\n- ".join(report.issues)
                + "\nProduce the corrected full translation. Output ONLY the "
                  "translated document."},
        ]
        out2 = call(retry, model=model, api_key=api_key)
        report2 = guards.run_guards(target_language, text, out2)
        if len(report2.hard) <= len(report.hard):
            out, report = out2, report2
    if not report.passed:
        raise TranslationError("the translation did not preserve the "
                               "document's structure")
    return {"markdown": out.strip() + "\n", "detection": detection,
            "stance": stance, "guard": {"passed": True, "notes": report.soft}}


def translate_doc(doc_json: dict, target_language: str, *, model: str,
                  api_key: str, call: ModelCall) -> dict:
    """Stored document -> same structure with every text segment translated
    in place, plus markdown re-rendered from the translated document."""
    segs = doc_segments(doc_json)
    if not segs:
        raise TranslationError("there is nothing to translate")
    sample = plain_text("\n".join(s["text"] for s in segs))[:2000]
    detection = detect(sample, model=model, api_key=api_key, call=call)
    stance = corpus.stance_for_category(detection["category"])
    system = build_system_prompt(
        target_language=target_language, category=detection["category"],
        stance=stance, source_language=detection["source_language"],
        mode="segments")
    texts = [s["text"] for s in segs]
    messages: Messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": json.dumps(texts, ensure_ascii=False)},
    ]

    def attempt(msgs: Messages) -> Optional[List[str]]:
        content = call(msgs, model=model, api_key=api_key)
        try:
            arr = _extract_json(content)
        except Exception:
            return None
        if not isinstance(arr, list) or len(arr) != len(texts):
            return None
        return [str(x) for x in arr]

    translated = attempt(messages)
    if translated is None:
        translated = attempt(messages)  # one clean retry on shape failure
    if translated is None:
        raise TranslationError("the translation did not come back in a "
                               "usable shape")

    joined = "\n".join(strip_style_tags(_TAG_RE.sub(" ", t)) for t in translated)
    script_issues = guards.check_target_script(target_language, joined)
    if script_issues:
        retry = messages + [
            {"role": "assistant", "content": json.dumps(translated, ensure_ascii=False)},
            {"role": "user", "content":
                "Your translation violated these hard rules:\n- "
                + "\n- ".join(script_issues)
                + "\nProduce the corrected full JSON array. Output ONLY the array."},
        ]
        retried = attempt(retry)
        if retried is not None:
            joined2 = "\n".join(strip_style_tags(_TAG_RE.sub(" ", t)) for t in retried)
            if not guards.check_target_script(target_language, joined2):
                translated, script_issues = retried, []
    if script_issues:
        raise TranslationError("the translation kept coming back in the "
                               "wrong script")

    new_doc, notes = _splice(doc_json, segs, translated)
    source_joined = "\n".join(strip_style_tags(_TAG_RE.sub(" ", t)) for t in texts)
    notes += guards.check_numerals(source_joined, joined)

    from ..reflow.docmodel import Doc
    from ..reflow.render_md import render_markdown
    markdown = render_markdown(Doc.from_json(json.dumps(new_doc)))
    return {"doc_json": new_doc, "markdown": markdown, "detection": detection,
            "stance": stance, "guard": {"passed": True, "notes": notes}}


# --------------------------------------------------------------------------- #
# Hosted model client (networked; injected as a stub in tests)
# --------------------------------------------------------------------------- #
# OpenAI-compatible chat-completions endpoint of the model host. One constant,
# so the provider stays a single replaceable detail (white-labeled; never
# surfaced to users).
_TRANSLATE_API_URL = "https://openrouter.ai/api/v1/chat/completions"


def call_translate_model(messages: Messages, *, model: str, api_key: str,
                         timeout: float = 600.0) -> str:
    """One chat call -> assistant text. No max_tokens: capping output truncates
    long translations mid-document; the guards downstream keep us safe."""
    import httpx

    payload = {"model": model, "temperature": 0, "messages": messages}
    last_exc: Optional[Exception] = None
    for _ in range(3):
        try:
            resp = httpx.post(
                _TRANSLATE_API_URL,
                headers={"Authorization": f"Bearer {api_key}",
                         "content-type": "application/json"},
                json=payload, timeout=timeout,
            )
            resp.raise_for_status()
            return str(resp.json()["choices"][0]["message"]["content"])
        except Exception as exc:  # transient network / shape error
            last_exc = exc
    raise RuntimeError(f"translation model call failed: {last_exc}")
