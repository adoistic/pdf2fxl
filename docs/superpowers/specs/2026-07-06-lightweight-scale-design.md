# Thothica OCR: lightweight, R2-direct, scale-to-thousands design

Date: 2026-07-06. Author: Adnan (direction) with Claude (drafting).

## Goal

Process thousands of books concurrently while the app stays lightweight. Adnan's
principle: "just upload stuff to R2 and share the link, so nothing literally
touches the app." The Worker is a control plane (auth, credits, job state, short
lived URLs); heavy bytes flow client to R2 to container directly, never through
the Worker. Each job is bounded in memory so many run at once.

## Bottlenecks in the current build (single-file loop, already shipped)

1. Upload: the Worker buffers the whole PDF in memory (`arrayBuffer`, capped at
   100MB) before writing R2. Bytes and memory both hit the Worker.
2. Processing: the container held every page image at 300 DPI, ~3GB for 152 pages,
   OOM risk on 200+ page books and a hard cap on concurrency.
3. Artifacts and downloads: the container returns artifacts through the Worker;
   downloads stream through the Worker.

## Target architecture

**Control plane (Worker), data plane (R2 direct).**

1. **Bounded per-job memory (DONE 2026-07-06).** The container rasterizes reflow at
   150 DPI (heading maths is scale invariant, OCR fine), cutting peak from 3GB to
   ~1GB for 152 pages. A small container now runs several books; instances autoscale
   for bursts; the queue absorbs spikes. Further bounding (release page images per
   page) is a later optimization if books grow past ~300 pages.

2. **Direct-to-R2 uploads (needs an R2 API token).** `POST /api/jobs` returns a job
   id plus a presigned R2 PUT URL. The browser uploads the PDF straight to R2. The
   Worker never sees the bytes; the 100MB cap disappears. Interim, credential-free
   step: the Worker STREAMS the body to R2 (`STORE.put(key, request.body)`) instead
   of buffering, which bounds Worker memory now; PDF validity is checked by the
   container's /prepare, not by buffering magic bytes.

3. **Container reads and writes R2 directly (needs presigned URLs).** The Worker
   passes the container a presigned GET (input PDF) and presigned PUT URLs (verbatim,
   doc.json, markdown, figures). The container streams the PDF from R2, processes,
   and writes artifacts straight back to R2. It returns only a small manifest (page
   count, keys, ok). Artifacts never transit the Worker.

4. **Downloads as R2 links.** Markdown and stored artifacts: the Worker returns a
   presigned GET URL (or a redirect); the browser downloads straight from R2. EPUB
   and DOCX render on demand: the Worker asks the container to render into an R2 key
   (presigned PUT), caches it under `renders/{job}/`, and returns a presigned GET.
   Rendered bytes go container to R2 to browser, not through the Worker. A short R2
   lifecycle expires the render cache.

**Credits and lifecycle stay as they are:** hold at start, capture on the container
manifest, release on failure; originals deleted on completion with the 72h R2
lifecycle backstop. The state machine and the ledger are unchanged; only the byte
path moves off the Worker.

## What Adnan needs to provide

An **R2 API token** (Cloudflare dashboard: R2 -> Manage R2 API Tokens -> Create,
Object Read and Write on the `thothica-ocr` bucket). Its access key id and secret
become Worker secrets; the Worker mints presigned S3 URLs with them (via aws4fetch).
The wrangler OAuth token cannot create this (no token-admin scope).

## Rollout order

1. Bounded memory (150 DPI). DONE, deployed.
2. Streaming uploads (credential-free): stream the body to R2, drop buffering and
   the magic-byte check, rely on /prepare for validity.
3. R2 token wired as secrets; presigned URL helper (aws4fetch) in the Worker.
4. Direct-to-R2 uploads: presigned PUT from `POST /api/jobs`, front end PUTs to R2.
5. Container reads and writes R2 via presigned URLs; queue consumer passes URLs,
   stores nothing itself; capture on manifest.
6. Downloads as presigned R2 GET links; render-to-R2 cache for EPUB/DOCX.

## Out of scope here

Bulk multi-file / zip (its own plan, but it rides this same direct-to-R2 path, one
presigned PUT per file), fixed-layout pipeline, email, reflow hardening.
