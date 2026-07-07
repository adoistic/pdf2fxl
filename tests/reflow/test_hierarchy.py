from pdf2fxl.reflow.hierarchy import body_size
from pdf2fxl.reflow.segment import Segment


def _seg(type_, size, text):
    return Segment(page_index=0, type=type_, bbox=(0, 0, 10, 10), text=text,
                   size_px=size)


def test_body_size_is_the_char_mass_peak():
    segs = [
        _seg("text", 10.0, "x" * 500),   # lots of body at size 10
        _seg("text", 10.2, "y" * 400),
        _seg("title", 20.0, "Big Heading"),   # heading excluded
        _seg("text", 30.0, "z" * 5),     # tiny amount of large text
    ]
    assert 9.5 <= body_size(segs) <= 10.7


def test_body_size_empty_returns_zero():
    assert body_size([]) == 0.0


from pdf2fxl.reflow.hierarchy import parse_numbering


def test_dotted_decimal_depth():
    assert parse_numbering("1. Introduction") == 1
    assert parse_numbering("1.2 Historical Perspective") == 2
    assert parse_numbering("1.2.1. Early Discoveries") == 3


def test_roman_and_chapter_are_top_level():
    assert parse_numbering("IV. Methods") == 1
    assert parse_numbering("Chapter 3 The Gut") == 1


def test_devanagari_numeral_prefix():
    assert parse_numbering("२. प्रकरण") == 1


def test_no_numbering_returns_zero():
    assert parse_numbering("Introduction") == 0
    assert parse_numbering("Opportunity: consider this") == 0


from pdf2fxl.reflow.hierarchy import assign_levels


def _h(size, text):
    return Segment(page_index=0, type="title", bbox=(0, 0, 10, 10), text=text,
                   size_px=size)


def test_numbering_drives_levels_when_present():
    body = [_seg("text", 10.0, "x" * 300)]
    heads = [_h(18, "1. Introduction"), _h(15, "1.2 History"),
             _h(13, "1.2.1 Early")]
    assign_levels(heads + body)
    assert [h.level for h in heads] == [1, 2, 3]


def test_size_tiers_when_no_numbering():
    body = [_seg("text", 10.0, "x" * 300)]
    heads = [_h(24, "Part Title"), _h(16, "Section"), _h(16, "Another Section"),
             _h(12, "Small Sub")]
    assign_levels(heads + body)
    # largest size -> H1, next distinct tier -> H2, next -> H3
    assert heads[0].level == 1
    assert heads[1].level == 2 and heads[2].level == 2
    assert heads[3].level == 3


def test_non_headings_stay_level_zero():
    body = [_seg("text", 10.0, "x" * 300)]
    assign_levels(body)
    assert body[0].level == 0


def test_part_book_volume_are_top_level():
    from pdf2fxl.reflow.hierarchy import parse_numbering
    assert parse_numbering("Part 2. The Evolutionary Background") == 1
    assert parse_numbering("Part I") == 1
    assert parse_numbering("Book 3: Later Works") == 1
    assert parse_numbering("Volume II") == 1
    # unchanged: dotted decimals keep their depth, plain text is 0
    assert parse_numbering("2.1. Disease") == 2
    assert parse_numbering("2. Between Health") == 1
    assert parse_numbering("Participation trophies") == 0   # 'Part...' word, not a Part heading


def test_identical_unnumbered_headings_get_one_consistent_level():
    """Two headings with the same unnumbered text must not land on different
    levels from noisy size measurement (the real bug: 'Part 2' -> H1 while
    'Part 1'/'Part 3' -> H2)."""
    from pdf2fxl.reflow.hierarchy import assign_levels
    segs = [
        _seg("title", 30.0, "1. Alpha"),         # numbered chapter -> level 1
        _seg("text", 10.0, "body " * 40),
        _seg("title", 22.0, "Part 1"),           # unnumbered, size says ~tier 2...
        _seg("title", 30.0, "Part 2"),           # ...but this one measured larger
        _seg("title", 22.0, "Part 3"),
    ]
    assign_levels(segs)
    parts = [s.level for s in segs if s.text.startswith("Part")]
    assert len(set(parts)) == 1, f"Part headings got inconsistent levels: {parts}"


def test_recurring_unnumbered_heading_is_not_a_chapter():
    """A recurring unnumbered heading printed at chapter size (e.g. a per-chapter
    'References' section) must not be promoted to top level once per chapter --
    it is a section inside each chapter, not N separate chapters."""
    from pdf2fxl.reflow.hierarchy import assign_levels
    segs = []
    for c in range(1, 5):                              # 4 numbered chapters
        segs.append(_seg("title", 30.0, f"{c}. Chapter {c}"))       # -> level 1
        segs.append(_seg("title", 20.0, f"{c}.1 A section"))        # -> level 2
        segs.append(_seg("text", 10.0, "body " * 40))
        segs.append(_seg("title", 30.0, "References"))              # chapter-sized, recurs 4x
    assign_levels(segs)
    refs = [s.level for s in segs if s.text == "References"]
    assert all(lvl > 1 for lvl in refs), f"recurring 'References' promoted to H1: {refs}"
    assert len(set(refs)) == 1, f"recurring 'References' got inconsistent levels: {refs}"
    # real numbered chapters are untouched
    assert [s.level for s in segs if s.text.startswith("1. Chapter")] == [1]


# --- holistic (no-numbering) leveling: size + verbosity, not size alone ---------
def _hl(line, text, n_lines=1, span=0.0, centered=False, bold=False):
    """A heading with the content-invariant line_px set (plus n_lines/span/style)
    for the holistic path. span is encoded as ink extent against a 1000px column."""
    return Segment(page_index=0, type="title", bbox=(0, 0, 10, 10), text=text,
                   size_px=line, line_px=line, n_lines=n_lines,
                   ink_left=0.0, ink_right=span * 1000.0, centered=centered, bold=bold)


_COLW = lambda s: 1000.0


def test_robust_size_still_tiers_by_size():
    body = [_seg("text", 10.0, "x" * 400)]
    heads = [_hl(40, "Big"), _hl(28, "Middle"), _hl(28, "Middle Two"), _hl(20, "Small")]
    assign_levels(heads + body)
    assert heads[0].level == 1
    assert heads[1].level == heads[2].level       # equal robust size -> same tier
    assert heads[3].level > heads[1].level         # smaller -> lower tier


def test_long_verbose_fullwidth_heading_demoted_below_terse_peer():
    """Adnan's complaint at the leveling layer: a wordy full-width block that wraps
    reads like body and must rank BELOW a terse heading of the same robust size."""
    body = [_seg("text", 10.0, "x" * 400)]
    top = _hl(40, "Chapter One", n_lines=1, span=0.3)
    terse = _hl(28, "Methods", n_lines=1, span=0.2)
    verbose = _hl(28, "a very long descriptive heading that fills the whole measure "
                      "and wraps onto a second line reading just like body text",
                  n_lines=2, span=0.95)
    assign_levels([top, terse, verbose] + body, col_w_of=_COLW)
    assert top.level == 1
    assert verbose.level > terse.level             # same size, demoted for being body-like


def test_largest_type_heading_never_demoted_even_if_long():
    """The guard: a genuinely large title stays H1 even if it is long/full-width/
    multi-line -- big type is authoritative."""
    body = [_seg("text", 10.0, "x" * 400)]
    biglong = _hl(44, "A Long But Genuinely Top Level Chapter Title That Wraps Across Here",
                  n_lines=2, span=0.95)
    sub = _hl(24, "Section", n_lines=1, span=0.2)
    sub2 = _hl(18, "Subsection", n_lines=1, span=0.2)
    assign_levels([biglong, sub, sub2] + body, col_w_of=_COLW)
    assert biglong.level == 1
    assert sub.level > 1


def test_numbering_still_wins_even_with_markdown_markers():
    body = [_seg("text", 10.0, "x" * 300)]
    heads = [_hl(18, "**1. Introduction**"), _hl(15, "*1.2 History*"),
             _hl(13, "1.2.1 Early")]
    assign_levels(heads + body)
    assert [h.level for h in heads] == [1, 2, 3]   # strip_inline_md before numbering
