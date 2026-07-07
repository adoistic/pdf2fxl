"""Emphasis enrichment: recover bold/italic/underline that OCR drops.

A post-OCR pass. For each page we show a hosted vision model the page image plus
that page's OCR text blocks and ask it to return the SAME text with only
<b>/<i>/<u> tags added. The model's output is used *only* to decide which
character ranges are emphasized — never as text. Every rendered character is
sliced from the document's own original run text, so this pass can never alter or
corrupt text; it can only add styling on top of what the engine already detected.

Pure functions here are unit-tested without any network. The one networked
helper (`call_emphasis_model`) is injected so tests pass a stub.
"""

from __future__ import annotations

import base64
import json
import re
from difflib import SequenceMatcher
from typing import Callable, Dict, FrozenSet, List, Optional, Set, Tuple

# Recognized inline emphasis tags, case-insensitive. Everything else the model
# might emit (other tags, HTML entities, reflowed whitespace) is caught by the
# byte-exact gate in `emphasized_spans`, so it is not special-cased here.
_TAG = re.compile(r"<\s*(/?)\s*(b|i|u|strong|em)\s*>", re.IGNORECASE)
_STYLE_OF = {"b": "bold", "strong": "bold", "i": "italic", "em": "italic", "u": "underline"}

Owner = Tuple[int, int, int]   # (node_index, run_index, char_index)
Span = Tuple[int, int, FrozenSet[str]]


# The prompt is a versioned constant so it is reviewable and testable. Adnan will
# refine the exact wording; the contract (verbatim text, same-length JSON array,
# only b/i/u tags) must be preserved by any edit.
ENRICH_INSTRUCTION = (
    "You are given an image of a single book page and a JSON array of the text "
    "blocks OCR extracted from it, in reading order. For each block, look at the "
    "page image and mark the words that are visually bold, italic, or underlined. "
    "Wrap bold spans in <b></b>, italic spans in <i></i>, and underlined spans in "
    "<u></u>. Return ONLY a JSON array of the same length and order, where each "
    "element is the corresponding input string returned character-for-character "
    "verbatim with only those three tags added. Do not translate, correct, "
    "re-punctuate, reflow whitespace, escape characters, or change the text in any "
    "way. If a block has no emphasis, return it unchanged. Output only the JSON "
    "array, nothing else."
)


# --------------------------------------------------------------------------- #
# Tag parsing + integrity gate (pure)
# --------------------------------------------------------------------------- #
def parse_emphasis(s: str) -> Optional[Tuple[str, List[Span]]]:
    """Parse recognized emphasis tags into (plain_text, spans).

    spans are maximal runs of equal, non-empty style over plain_text coordinates.
    Returns None on structurally malformed input (a close with no open, or a tag
    left open at end) — proper nesting and overlap are handled via per-style open
    counts.
    """
    counts = {"bold": 0, "italic": 0, "underline": 0}
    plain: List[str] = []
    style_at: List[FrozenSet[str]] = []

    def emit(text: str) -> None:
        cur = frozenset(k for k, v in counts.items() if v > 0)
        for ch in text:
            plain.append(ch)
            style_at.append(cur)

    pos = 0
    for m in _TAG.finditer(s):
        emit(s[pos:m.start()])
        closing, name = m.group(1), m.group(2).lower()
        style = _STYLE_OF[name]
        if closing:
            counts[style] -= 1
            if counts[style] < 0:
                return None  # close without a matching open
        else:
            counts[style] += 1
        pos = m.end()
    emit(s[pos:])

    if any(v != 0 for v in counts.values()):
        return None  # a tag was never closed

    spans: List[Span] = []
    i, n = 0, len(style_at)
    while i < n:
        st = style_at[i]
        if not st:
            i += 1
            continue
        j = i
        while j < n and style_at[j] == st:
            j += 1
        spans.append((i, j, st))
        i = j
    return "".join(plain), spans


def emphasized_spans(returned: str, original: str) -> Optional[List[Span]]:
    """Emphasis spans for a block, or None if the model deviated from the text.

    The gate is byte-exact with NO normalization: the tag-stripped text must equal
    the original exactly, so a reflowed space, an HTML entity, an unrecognized tag,
    or any dropped/changed word makes the whole block fail (and render plain).
    """
    parsed = parse_emphasis(returned)
    if parsed is None:
        return None
    plain, spans = parsed
    if plain != original:
        return None
    return spans


# --------------------------------------------------------------------------- #
# Doc character stream + run rebuild (pure, operates on doc.json dict)
# --------------------------------------------------------------------------- #
def _paragraphs(doc_json: dict):
    for p, node in enumerate(doc_json.get("nodes", [])):
        if node.get("_kind") == "Paragraph":
            yield p, node


def build_doc_stream(doc_json: dict) -> Tuple[str, List[Optional[Owner]]]:
    """Concatenate every Paragraph run's text (paragraphs newline-separated) with a
    parallel owner list: owners[k] is the (node, run, char) that produced stream
    char k, or None for a paragraph separator."""
    chars: List[str] = []
    owners: List[Optional[Owner]] = []
    first = True
    for p, node in _paragraphs(doc_json):
        if not first:
            chars.append("\n")
            owners.append(None)
        first = False
        for r, run in enumerate(node.get("runs", [])):
            for c, ch in enumerate(run.get("text", "")):
                chars.append(ch)
                owners.append((p, r, c))
    return "".join(chars), owners


def _rebuild_paragraph(node: dict, added: Dict[Owner, Set[str]], p: int) -> None:
    """Rebuild one Paragraph's runs, OR-ing detected styles onto existing ones and
    slicing text from the original runs so text is preserved exactly."""
    new_runs: List[dict] = []
    for r, run in enumerate(node.get("runs", [])):
        text = run.get("text", "")
        base = (bool(run.get("bold")), bool(run.get("italic")), bool(run.get("underline")))
        drop = bool(run.get("dropcap"))
        if text == "":
            new_runs.append({"text": "", "bold": base[0], "italic": base[1],
                             "underline": base[2], "dropcap": drop})
            continue
        # Final per-char style = base OR detected.
        styled: List[Tuple[str, bool, bool, bool]] = []
        for c, ch in enumerate(text):
            extra = added.get((p, r, c), frozenset())
            styled.append((ch, base[0] or "bold" in extra,
                           base[1] or "italic" in extra,
                           base[2] or "underline" in extra))
        i, first_sub = 0, True
        while i < len(styled):
            _, fb, fi, fu = styled[i]
            j = i
            buf: List[str] = []
            while j < len(styled) and styled[j][1:] == (fb, fi, fu):
                buf.append(styled[j][0])
                j += 1
            new_runs.append({"text": "".join(buf), "bold": fb, "italic": fi,
                             "underline": fu, "dropcap": drop if first_sub else False})
            first_sub = False
            i = j
    node["runs"] = new_runs


# --------------------------------------------------------------------------- #
# Alignment: map a block's emphasized spans onto doc offsets (pure)
# --------------------------------------------------------------------------- #
def _align_block(doc_stream: str, start: int, end: int, block: str) -> Tuple[Dict[int, int], int]:
    """Map block char index -> global doc position for the region of `doc_stream`
    that matches `block`, tolerating the engine's de-hyphenation/trim/reorder.
    Returns (posmap, match_end) where match_end is the global position just past
    the matched region (for advancing the monotonic cursor)."""
    window = doc_stream[start:end]
    sm = SequenceMatcher(None, window, block, autojunk=False)
    posmap: Dict[int, int] = {}
    match_end = start
    for di, bj, size in sm.get_matching_blocks():
        if size == 0:
            continue
        for t in range(size):
            posmap[bj + t] = start + di + t
        match_end = max(match_end, start + di + size)
    return posmap, match_end


def apply_page_spans(
    doc_stream: str,
    owners: List[Optional[Owner]],
    cursor: int,
    block_texts: List[str],
    block_spans: List[Optional[List[Span]]],
    added: Dict[Owner, Set[str]],
) -> int:
    """Fold one page's per-block emphasis into `added`, advancing and returning the
    monotonic cursor. Spans that do not align to any doc position are dropped."""
    for block, spans in zip(block_texts, block_spans):
        if not spans:
            continue
        end = min(len(doc_stream), cursor + max(len(block) * 3, len(block) + 200))
        posmap, match_end = _align_block(doc_stream, cursor, end, block)
        if not posmap:
            continue
        for s0, s1, style in spans:
            for k in range(s0, s1):
                g = posmap.get(k)
                if g is None:
                    continue
                owner = owners[g]
                if owner is None:
                    continue
                added.setdefault(owner, set()).update(style)
        cursor = max(cursor, match_end)
    return cursor


# --------------------------------------------------------------------------- #
# Page block extraction + orchestration
# --------------------------------------------------------------------------- #
def page_block_texts(verbatim_page: dict) -> List[str]:
    """The non-image OCR block texts for one page, in reading order."""
    pages = verbatim_page.get("pages") or []
    if not pages:
        return []
    out: List[str] = []
    for b in pages[0].get("blocks", []) or []:
        if b.get("type") == "image":
            continue
        content = b.get("content")
        if content:
            out.append(content)
    return out


ModelCall = Callable[..., List[str]]
PageImage = Callable[[int], bytes]


def enrich_doc_json(
    doc_json: dict,
    verbatim: List[dict],
    page_image: PageImage,
    model_call: ModelCall,
    *,
    model: str,
    api_key: str,
    instruction: str = ENRICH_INSTRUCTION,
) -> Tuple[int, int, bool]:
    """Mutate doc_json in place, applying detected emphasis to Paragraph runs.

    Returns (pages_total, pages_enriched, changed) where `changed` is True iff any
    emphasis was actually applied (so the caller can skip re-rendering markdown on
    a no-op). A page is enriched when its model call
    succeeded and returned a structurally valid, same-length array — the detection
    ran and was usable. A page whose call errored or returned an unusable shape is
    not enriched (the caller refunds its surcharge). Individual blocks that fail
    the integrity gate are skipped without un-billing the page.
    """
    doc_stream, owners = build_doc_stream(doc_json)
    added: Dict[Owner, Set[str]] = {}
    cursor = 0
    pages_total = len(verbatim)
    pages_enriched = 0

    for i in range(pages_total):
        block_texts = page_block_texts(verbatim[i])
        if not block_texts:
            pages_enriched += 1  # nothing to detect; not a failure
            continue
        try:
            returned = model_call(page_image(i), block_texts, model=model,
                                  api_key=api_key, instruction=instruction)
        except Exception:
            continue  # not enriched -> refunded
        if not isinstance(returned, list) or len(returned) != len(block_texts):
            continue  # unusable -> refunded
        pages_enriched += 1
        block_spans = [emphasized_spans(str(r), o) for o, r in zip(block_texts, returned)]
        cursor = apply_page_spans(doc_stream, owners, cursor, block_texts, block_spans, added)

    if added:
        touched = {p for (p, _r, _c) in added}
        for p, node in _paragraphs(doc_json):
            if p in touched:
                _rebuild_paragraph(node, added, p)
    return pages_total, pages_enriched, bool(added)


# --------------------------------------------------------------------------- #
# Hosted vision-model client (networked; injected as a stub in tests)
# --------------------------------------------------------------------------- #
# OpenAI-compatible chat-completions endpoint of the model host. Kept in one
# constant so the provider stays a single, replaceable detail (white-labeled;
# never surfaced to users).
_EMPHASIS_API_URL = "https://openrouter.ai/api/v1/chat/completions"


def _extract_json_array(text: str) -> list:
    """Parse a JSON array out of a model reply, tolerating code fences or a little
    surrounding prose (some models wrap the array). Raises if none is found."""
    t = text.strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z]*\n?", "", t)
        t = re.sub(r"\n?```$", "", t).strip()
    try:
        arr = json.loads(t)
    except Exception:
        start, end = t.find("["), t.rfind("]")
        if start == -1 or end <= start:
            raise ValueError("no JSON array in model reply")
        arr = json.loads(t[start:end + 1])
    if not isinstance(arr, list):
        raise ValueError("model did not return a JSON array")
    return arr


def call_emphasis_model(
    image_png: bytes,
    block_texts: List[str],
    *,
    model: str,
    api_key: str,
    instruction: str,
    timeout: float = 120.0,
) -> List[str]:
    """One vision call: page image + block texts -> same-length tagged array.

    NOTE: `max_tokens` is deliberately NOT set. Capping output tokens truncates
    the returned array on long pages, which then fails the length/gate check and
    needlessly drops (and refunds) enrichment. Let the model return its full
    response; the integrity gate downstream is what keeps us safe.
    """
    import httpx

    data_url = "data:image/png;base64," + base64.b64encode(image_png).decode()
    payload = {
        "model": model,
        "temperature": 0,
        "messages": [
            {"role": "system", "content": instruction},
            {"role": "user", "content": [
                {"type": "text", "text": json.dumps(block_texts, ensure_ascii=False)},
                {"type": "image_url", "image_url": {"url": data_url}},
            ]},
        ],
    }
    last_exc: Optional[Exception] = None
    for _ in range(3):
        try:
            resp = httpx.post(
                _EMPHASIS_API_URL,
                headers={"Authorization": f"Bearer {api_key}",
                         "content-type": "application/json"},
                json=payload, timeout=timeout,
            )
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"]
            return [str(x) for x in _extract_json_array(content)]
        except Exception as exc:  # transient network / shape error
            last_exc = exc
    raise RuntimeError(f"emphasis model call failed: {last_exc}")
