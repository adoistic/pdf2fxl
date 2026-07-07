"""Inline markdown emphasis -> styled runs, and the false-positive guards."""
from pdf2fxl.reflow.inline_md import parse_inline_md, strip_inline_md


def _tuples(runs):
    return [(r.text, r.bold, r.italic) for r in runs]


def test_bold_splits_into_styled_runs():
    # The exact bug from Adnan's screenshot: **Automation** must become real bold,
    # not literal asterisks.
    runs = parse_inline_md("**Automation** -> Reduces repetitive tasks.")
    assert _tuples(runs) == [
        ("Automation", True, False),
        (" -> Reduces repetitive tasks.", False, False),
    ]


def test_italic_single_marker():
    assert _tuples(parse_inline_md("a *word* here")) == [
        ("a ", False, False), ("word", False, True), (" here", False, False)]


def test_underscore_bold_and_italic():
    assert _tuples(parse_inline_md("__b__ and _i_")) == [
        ("b", True, False), (" and ", False, False), ("i", False, True)]


def test_base_bold_ors_into_every_run():
    runs = parse_inline_md("plain *em* tail", base_bold=True)
    assert all(r.bold for r in runs)
    assert [r.italic for r in runs] == [False, True, False]


def test_nested_bold_italic():
    # **a *b* c** -> a,c bold; b bold+italic
    runs = parse_inline_md("**a *b* c**")
    assert _tuples(runs) == [
        ("a ", True, False), ("b", True, True), (" c", True, False)]


# --- false-positive guards: these must stay LITERAL (markers preserved) ---
import pytest


@pytest.mark.parametrize("text", [
    "run_in_background",          # snake_case
    "snake_case_here",
    "C_2H_5 formula",            # chem subscript
    "a * b * c",                 # spaced math
    "3*4*5",                     # tight math
    "**Automation",              # unclosed bold
    "Automation**",              # dangling closer
    "**bold*",                   # length mismatch
    "**",                        # bare markers
    "****",                      # empty emphasis
    "***both***",                # run >= 3
])
def test_literal_markers_are_preserved(text):
    # strip must be a no-op: nothing matched, so no markers removed.
    assert strip_inline_md(text) == text
    # and parse yields a single unstyled run equal to the input.
    runs = parse_inline_md(text)
    assert "".join(r.text for r in runs) == text
    assert not any(r.bold or r.italic for r in runs)


def test_word_italic_still_works_despite_math_guard():
    assert _tuples(parse_inline_md("*word*")) == [("word", False, True)]


def test_strip_for_headings_removes_matched_markers():
    assert strip_inline_md("**Chapter One**") == "Chapter One"
    assert strip_inline_md("*A Section*") == "A Section"
    # unmatched stays
    assert strip_inline_md("**Chapter") == "**Chapter"


def test_empty_and_none():
    assert parse_inline_md("") == []
    assert strip_inline_md("") == ""


def test_full_text_preserved_property():
    # For any matched/unmatched mix, concatenated run text equals input minus the
    # matched-pair markers only (never drops content characters).
    text = "See **bold**, *italic*, a_b, and 2*3 here."
    out = "".join(r.text for r in parse_inline_md(text))
    assert out == "See bold, italic, a_b, and 2*3 here."
