# Reflow quality on a real book (microbiome, 152pp), 2026-07-06

Ran the full reflow engine (realtime OCR) on
`Dysbiosis_of_the_Evolved_Intestinal_Microbiome.pdf` (152 pages, clean single column).

## Works
- Real chapter titles recovered as H1: "5 The Holobiont", "6 The Primacy of the
  Immune System", "About the Author", "Preface", "1. Introduction".
- Per-chapter "References" sections and "Part N" recovered as H2.
- 26 H1, 145 H2. A coherent, usable hierarchy from a real book.
- Timing: 551s SEQUENTIAL locally. The container `/process` OCRs concurrently
  (10 workers), so ~1 minute for 152 pages, well inside the queue budget.

## Hardening opportunities (follow-up, not launch blockers)
1. Table-of-contents entries are detected as headings, with trailing page numbers
   ("Part 1 ... 29", "The Holobiont 51"). The Contents page needs suppression, and
   heading text should strip trailing page-number runs.
2. Part-vs-chapter level inversion: Parts came out H2, chapters H1; Parts should
   outrank chapters. The tier reconciliation should treat "Part N" as above numbered
   chapters.
3. Repeated "References NN" headings inherit page numbers from running heads.

These match the original roadmap's "harden reflow on real books" (reading order at
chapter openers, TOC handling). Track for a post-launch reflow-hardening plan.
