# AI-native repositories: session kickoff

Paste this whole file into a new session as the first message, or say "read
docs/ai-native-handoff.md and continue." It explains who I am, what we are building,
how we work, what already exists, and what to do next.

---

## Who I am

I am Adnan. I work at Thothica. Address me as Adnan. The macOS account on this machine
is `siraj` and paths may render that way; that is a system identifier, not me.

Thothica builds AI-native knowledge infrastructure: systems that help institutions
structure, connect, and operationalize fragmented knowledge so people and AI can work
over it and trust it. The house stance is "a librarian, not a second LLM": every claim
binds to a verbatim source behind a verify gate, and the system says so when it cannot
source an answer rather than guessing. Write and build in that spirit: precise, calm,
accountable, plain English, sentence case, and no em dashes or en dashes anywhere.

## The goal

I am turning my repositories into AI-native repositories, and I want to keep doing that
across all of my applications, not just this one. "AI-native" means the repo is built to
be worked on by AI agents as the primary mode of development: every feature goes through
a written spec and a task-by-task plan, work is executed and verified by agents against
tests and real runs, decisions and hard-won lessons are captured in durable memory, and
the house brand and voice are applied automatically. The repo carries its own operating
manual so any fresh agent session can pick up the work with full context.

Two things I still need to decide with you (treat these as open, do not assume):
1. Whether "AI-native repo" means one consolidated monorepo for all Thothica apps, or
   each existing repo made AI-agent-ready with the same shared method. Ask me.
2. Which other applications and repositories are in scope, where they live, and their
   current state. I will list them; do not invent them.

## How we work (the operating method)

This is the most important part. Follow it exactly; it is why the work holds up.

1. **Skills first.** This machine has a large skill library (the "superpowers" set, the
   Thothica brand skill, frontend-design, and many domain skills). Before acting on any
   task, check whether a skill applies and invoke it. Process skills (brainstorming,
   debugging) come before implementation skills.

2. **Brainstorm to a spec.** For any new feature, use the brainstorming skill: explore
   intent with one question at a time, propose a couple of approaches with a
   recommendation, then write a spec to `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
   and get my approval. Do not write code before an approved design.

3. **Write a plan.** Turn the approved spec into a task-by-task implementation plan at
   `docs/superpowers/plans/YYYY-MM-DD-<feature>.md`. Each task is small, test-first (TDD),
   with the actual test and implementation code and a commit step. No placeholders.

4. **Execute with subagents.** Run the plan task by task, a fresh subagent per task where
   it helps, tests green before moving on, one commit per task. Parallelize independent
   modules. Long backend builds can run in the background while I keep working elsewhere.

5. **Verify before claiming done.** Never trust unit tests for anything visual. Run the
   real thing and look at it: render EPUBs and screenshot them, exercise the web app in a
   browser, check real OCR output. Evidence before assertions. This rule has already
   saved a full debugging loop on this repo, keep it.

6. **Remember.** Durable memory lives at
   `~/.claude/projects/-Users-siraj-fixed-layout-pdf-to-epub/memory/` with a `MEMORY.md`
   index. Save project state, my feedback and its rationale, and non-obvious facts, one
   file per fact. Read the index at session start; verify a remembered detail still exists
   before acting on it.

7. **Brand everything.** Any deliverable I will see or share (web UI, decks, docs, PDFs)
   goes through the Thothica brand skill: warm editorial, Cormorant Garamond plus Teachers,
   the brown/gold/cream palette with gold as seasoning, the real ibis logo asset (never
   redrawn), sentence case, and zero em/en dashes. Lint the visible copy for dashes.

8. **Git hygiene.** Branch off main for feature work, commit per task, end commit messages
   with the Co-Authored-By trailer. Commit or push only when I ask, unless we have already
   agreed on a rhythm for the session.

## What we have built so far

The current repo is **pdf2fxl** (on disk at `/Users/siraj/fixed layout pdf to epub`,
GitHub `adoistic/pdf2fxl`, private). It converts scanned and image-only book PDFs into
clean digital editions using Mistral OCR 4. It has two paths.

**1. Fixed-layout path (shipped first).** Image-only picture-book PDFs become a
fixed-layout EPUB3 and a PPTX with real, editable OCR text: ingest and trim with PyMuPDF,
OCR and layout with Mistral OCR 4, build a text mask, inpaint the baked-in text with LaMa,
solve font sizes to fit each box, and render. A per-page JSON is the shared contract.
Indic scripts are supported via an embedded font.

**2. Reflow mode (`--mode reflow`).** Scanned *text* books become a reflowable EPUB plus
Markdown and DOCX, with a real heading hierarchy recovered from OCR geometry. The core
idea is mine and it is the point of the feature: Mistral is trusted for what a block is
(heading or not) and where it sits, but not for the heading *level*, because it only sees
one page. So we compute the level ourselves, book-globally and mathematically:
- measure each block's true type size from the scan's ink-row line pitch, not from a
  fit-to-box guess and not from Mistral's numbers,
- take body size as the peak of the character-mass histogram,
- cluster the larger sizes into tiers and reconcile them with section numbering like
  1.2.1, so levels are consistent across the whole book,
- normalize layout: split two-up spreads, strip running heads and footers, merge drop
  caps, and rejoin paragraphs across page breaks,
- size every figure and table in proportion to its column.
A JSON `Doc` model feeds three renderers (EPUB, Markdown, DOCX). Built via a 21-task
TDD plan; the fast suite is 82 tests green. Spec and plan are under `docs/superpowers/`.

**3. Web console (FastAPI, port 8028).** A Thothica-branded front end for reflow mode:
drop a scanned PDF, watch real per-page OCR progress, read the recovered table of contents,
and download the EPUB, Markdown, and DOCX. In-memory threaded jobs, resumable `/?job=<id>`
links. The front end is warm editorial, responsive from mobile to ultra-wide, and its hero
carries a vector figure that shows type sizes clustering into heading tiers, so the page
explains the maths. Run it with `pdf2fxl-web` (or `python -m pdf2fxl.web`); it reads
`MISTRAL_API_KEY` from `.env`.

**4. Auto font by script.** Users never pick a font. The book's own text is scanned by
Unicode block to detect its writing systems; the bundled Noto Serif covers Latin, Greek,
and Cyrillic, and every other script (Devanagari, Arabic, Tamil, CJK, Hebrew, Thai, and
the rest) has its matching Noto face fetched from the Google Fonts CSS2 API, cached, and
embedded with a `font-family` stack and `unicode-range` so each script routes to its font.
A Latin-only book needs no network. Verified end to end: the Marathi book renders correct
Devanagari shaping from the embedded webfont.

### Where things live
- Engine and CLI: `src/pdf2fxl/` (reflow code in `src/pdf2fxl/reflow/`).
- Web app: `src/pdf2fxl/web/` (FastAPI in `app.py`, jobs in `jobs.py`, front end in
  `templates/` and `static/`).
- Specs: `docs/superpowers/specs/`. Plans: `docs/superpowers/plans/`.
- Tests: `tests/` (reflow tests in `tests/reflow/`).
- Fonts: `assets/fonts/` (bundled Noto, SIL OFL).

### Environment and conventions
- Python 3.14 in `.venv`. Install with `pip install -e '.[dev]'`, web extras with
  `pip install -e '.[web]'`. Fast tests: `.venv/bin/python -m pytest -q -m 'not slow'`.
- Mistral OCR key is in a gitignored `.env`; the CLI and web app auto-load it.
- The web console serves on port 8028 (not 8000).
- LaMa inpainting (torch plus simple-lama) is an optional backend, installed separately;
  nothing in the fast suite needs it.

## Strategy and roadmap

Near term on this repo:
- Run all three reference books end to end through reflow and eyeball the EPUBs (the full
  visual gate): the dental book with section numbering, the clean single-column microbiome
  book, and the Marathi two-up book with Devanagari. Note any hierarchy or layout misfires.
- Harden reflow on real books: reading-order edge cases at chapter openers, tables as real
  HTML versus image crops, formula handling, and figure placement.

Broader, the AI-native direction:
- Make each repo self-describing: a short operating manual (like this file), specs and
  plans in a predictable place, a memory index, and a clean test and verify loop, so any
  agent session is productive immediately.
- Decide the consolidation shape (monorepo versus shared method across repos) and apply
  the same discipline to the other applications once you tell me what they are.

## What I need you to do first

1. Read the memory index at
   `~/.claude/projects/-Users-siraj-fixed-layout-pdf-to-epub/memory/MEMORY.md` and the two
   memory files it points to, then skim the spec and plan under `docs/superpowers/`.
2. Confirm the environment: run the fast test suite and start the web console on 8028.
3. Ask me the two open questions above (consolidation shape, and the list of other
   applications and their repos), then we brainstorm the next piece of work into a spec.

Do not start writing feature code before we have an approved design for whatever we pick
next. Follow the operating method above.
