"""Plan 2b Task 1 spike: prove the Mistral batch OCR round trip on a real file.

Rasterizes the 17-page Pareeksha PDF, submits one /v1/ocr request per page to the
Mistral batch endpoint, polls to completion, retrieves results, and confirms the
result shape feeds parse_ocr_reflow. Throwaway: findings get written to a note.
"""
import base64
import io
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

import cv2  # noqa: E402
from mistralai.client import Mistral  # noqa: E402
from pdf2fxl.config import Config  # noqa: E402
from pdf2fxl.ingest import rasterize_page, page_count  # noqa: E402

PDF = "/Users/siraj/Downloads/test/Pareeksha Technologies.pdf"


def load_key() -> str:
    for line in Path("/Users/siraj/fixed layout pdf to epub/.env").read_text().splitlines():
        if line.startswith("MISTRAL_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("no MISTRAL_API_KEY in .env")


def main() -> None:
    key = load_key()
    client = Mistral(api_key=key)
    cfg = Config(mode="reflow")
    # Batch requires the alias, not the pinned mistral-ocr-4-0 the realtime path uses.
    batch_model = "mistral-ocr-latest"

    n = page_count(PDF)
    print(f"[spike] {PDF} has {n} pages; rasterizing + building JSONL", flush=True)
    t0 = time.time()
    lines = []
    sizes = {}
    for i in range(n):
        img = rasterize_page(PDF, i, cfg.zoom)
        h, w = img.shape[:2]
        sizes[i] = (w, h)
        ok, png = cv2.imencode(".png", img)
        data_url = "data:image/png;base64," + base64.b64encode(png.tobytes()).decode()
        lines.append(json.dumps({
            "custom_id": f"spike:{i}",
            "body": {
                "document": {"type": "image_url", "image_url": data_url},
                "include_image_base64": False,
            },
        }))
    jsonl = ("\n".join(lines)).encode()
    print(f"[spike] rasterized {n} pages in {time.time()-t0:.1f}s, JSONL {len(jsonl)//1024} KB", flush=True)

    up = client.files.upload(
        file={"file_name": "spike.jsonl", "content": jsonl},
        purpose="batch",
    )
    print(f"[spike] uploaded input file id={up.id}", flush=True)

    job = client.batch.jobs.create(
        input_files=[up.id],
        model=batch_model,
        endpoint="/v1/ocr",
        metadata={"spike": "pareeksha"},
    )
    print(f"[spike] created batch job id={job.id} status={job.status}", flush=True)

    t1 = time.time()
    while True:
        job = client.batch.jobs.get(job_id=job.id)
        done = job.completed_requests or 0
        total = job.total_requests or n
        print(f"[spike] status={job.status} {done}/{total} elapsed={time.time()-t1:.0f}s", flush=True)
        if job.status in ("SUCCESS", "FAILED", "TIMEOUT_EXCEEDED", "CANCELLED"):
            break
        time.sleep(15)

    print(f"[spike] final status={job.status} in {time.time()-t1:.0f}s", flush=True)
    if job.status != "SUCCESS":
        print(f"[spike] job did not succeed; errors={getattr(job,'errors',None)}", flush=True)
        return

    out = client.files.download(file_id=job.output_file)
    content = out.read() if hasattr(out, "read") else bytes(out)
    results = [json.loads(x) for x in content.decode().splitlines() if x.strip()]
    print(f"[spike] downloaded {len(results)} result lines", flush=True)

    first = results[0]
    print("[spike] first result keys:", list(first.keys()), flush=True)
    body = first.get("response", {}).get("body", first.get("response", first))
    pages = body.get("pages") if isinstance(body, dict) else None
    if pages:
        p0 = pages[0]
        print("[spike] page0 keys:", list(p0.keys()), flush=True)
        blocks = p0.get("blocks") or []
        print(f"[spike] page0 markdown chars={len(p0.get('markdown',''))} blocks={len(blocks)}", flush=True)
        if blocks:
            print("[spike] block0:", json.dumps(blocks[0])[:300], flush=True)
        print("[spike] page0 dimensions:", p0.get("dimensions"), flush=True)

    # feed one page through the reflow parser to confirm shape compatibility
    try:
        from pdf2fxl.reflow.ocr_reflow import parse_ocr_reflow
        cid = first.get("custom_id", "spike:0")
        idx = int(cid.split(":")[1])
        segs = parse_ocr_reflow(body, sizes[idx])
        print(f"[spike] parse_ocr_reflow OK: {len(segs)} segments on page {idx}", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"[spike] parse_ocr_reflow FAILED: {e!r}", flush=True)

    Path("/Users/siraj/fixed layout pdf to epub/cloud/container/spike_out.json").write_text(
        json.dumps({"status": job.status, "n_results": len(results),
                    "first_keys": list(first.keys())}, indent=2))
    print("[spike] done", flush=True)


if __name__ == "__main__":
    main()
