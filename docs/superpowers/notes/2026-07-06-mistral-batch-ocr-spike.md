# Mistral batch OCR spike, findings (2026-07-06)

Ran plan 2b Task 1 against the real API with the 17-page Pareeksha PDF.

## What works
- Rasterize 17 pages: 0.7s. JSONL of base64 page images: ~13 MB.
- Files API upload + batch job create + poll + download: all work.
- Batch OCR of 17 pages: SUCCESS in 31 seconds. Fast and viable at volume.
- Model name: batch requires `mistral-ocr-latest`. The engine's realtime id
  `mistral-ocr-4-0` is rejected by batch with a 422 access error.
- Realtime OCR with `include_blocks=True` returns 16 blocks per page with bboxes
  in the SAME pixel coordinate space as our rasterized image (2550x3300, dpi 200).
  `parse_ocr_reflow` produces 16 correct segments; the heading is recognized.

## The blocker
- Batch OCR does NOT return blocks. The batch request schema rejects
  `include_blocks` (server 422: `body.OCRRequest.include_blocks Extra inputs are
  not permitted`). A batch OCR result carries page markdown and dimensions but no
  per-block bounding boxes.
- The reflow product recovers heading levels from block geometry (type size via
  ink-row projection inside each block bbox), book-globally. Without bboxes the
  algorithm cannot run. Mistral's own markdown headings are exactly what the
  design distrusts (single-page view), so falling back to them abandons the
  differentiator.

## Consequence
Batch OCR (the 50 percent cheaper path) is incompatible with the geometry-based
reflow. Realtime OCR (`ocr.process` with `include_blocks=True`) is required to
get bboxes. Realtime can be parallelized in the container (async, concurrency
~8-12) so a 200-page book still finishes in well under a minute. The lost batch
discount is marginal in absolute terms (Mistral OCR is roughly $1 per 1000 pages
realtime; batch halves that), a few cents per book, versus the algorithm being
the entire product.

## Recommendation
Use realtime OCR with in-container concurrency for reflow. Revisit batch only if a
separate cheap tier that trusts Mistral's markdown headings is ever wanted.
Decision belongs to Adnan since "always use batch to save cost" was explicit.
