import type { Env } from "./types";
import { captureHold, releaseHold } from "./ledger";
import { failJob, transition, type Job } from "./jobs";

// The container call is injected so tests need no container or Mistral: the
// queue handler passes the real container fetch, tests pass a stub returning
// fixture artifacts.
export type ProcessFn = (
  pdf: ArrayBuffer,
  job: Job
) => Promise<{
  page_count: number;
  verbatim: unknown[];
  doc_json: unknown;
  markdown: string;
  figures: { name: string; base64: string }[];
}>;

type FinalizeRow = {
  id: string; user_id: number; mode: Job["mode"]; express: number; status: Job["status"];
  title: string | null; page_count: number | null; rate_mcr: number | null;
  hold_id: number | null; r2_upload_key: string | null; error_public: string | null;
  created_at: string;
};

function toJob(r: FinalizeRow): Job {
  return {
    id: r.id, userId: r.user_id, mode: r.mode, express: r.express === 1,
    status: r.status, title: r.title, pageCount: r.page_count, rateMcr: r.rate_mcr,
    holdId: r.hold_id, r2UploadKey: r.r2_upload_key, errorPublic: r.error_public,
    createdAt: r.created_at,
  };
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Finalize one job: read its upload from R2, run the (injected) container
// process, store the artifacts, capture the hold, mark the job ready, and
// delete the original upload. Idempotent: a retry after a clean success finds
// the job in 'ready' and returns "skipped" without touching anything. Any
// failure during processing releases the hold and keeps the upload for a retry.
export async function finalizeJob(
  env: Env,
  jobId: string,
  process: ProcessFn
): Promise<"ready" | "failed" | "skipped"> {
  const row = await env.DB
    .prepare(
      `SELECT id, user_id, mode, express, status, title, page_count, rate_mcr,
              hold_id, r2_upload_key, error_public, created_at
       FROM jobs WHERE id = ?1`
    )
    .bind(jobId)
    .first<FinalizeRow>();
  if (!row) return "skipped";
  const job = toJob(row);
  if (job.status !== "processing") return "skipped";

  const upload = job.r2UploadKey ? await env.STORE.get(job.r2UploadKey) : null;
  if (!upload) {
    await failJob(env.DB, jobId, "processing", "we could not read this file", "upload gone");
    if (job.holdId != null) await releaseHold(env.DB, job.holdId);
    return "failed";
  }

  try {
    const uploadBytes = await upload.arrayBuffer();
    const out = await process(uploadBytes, job);

    const verbatimKey = `ocr/${jobId}/verbatim.json`;
    const docKey = `doc/${jobId}/normalized.json`;
    const mdKey = `doc/${jobId}/normalized.md`;
    const figuresPrefix = `doc/${jobId}/figures/`;

    await env.STORE.put(verbatimKey, JSON.stringify(out.verbatim), {
      httpMetadata: { contentType: "application/json" },
    });
    await env.STORE.put(docKey, JSON.stringify(out.doc_json), {
      httpMetadata: { contentType: "application/json" },
    });
    await env.STORE.put(mdKey, out.markdown, {
      httpMetadata: { contentType: "text/markdown" },
    });
    for (const fig of out.figures) {
      await env.STORE.put(`${figuresPrefix}${fig.name}`, base64ToBytes(fig.base64));
    }

    // transition() only whitelists page_count/rate/hold/batch/engine, so the r2
    // keys and finished_at are written directly here, guarded on 'processing'.
    const updated = await env.DB
      .prepare(
        `UPDATE jobs SET r2_verbatim_key = ?1, r2_doc_key = ?2, r2_md_key = ?3,
                r2_figures_prefix = ?4, finished_at = datetime('now'),
                updated_at = datetime('now')
         WHERE id = ?5 AND status = 'processing'`
      )
      .bind(verbatimKey, docKey, mdKey, figuresPrefix, jobId)
      .run();
    if (updated.meta.changes !== 1) {
      // Someone else moved the job out of 'processing' concurrently; do not
      // capture or double-write. Treat as already-handled.
      return "skipped";
    }

    if (job.holdId != null) await captureHold(env.DB, job.holdId);
    await transition(env.DB, jobId, "processing", "ready");
    await env.STORE.delete(job.r2UploadKey!);
    return "ready";
  } catch (err) {
    await failJob(
      env.DB, jobId, "processing",
      "something went wrong while reading this document, your credits were not charged",
      String(err)
    );
    if (job.holdId != null) await releaseHold(env.DB, job.holdId);
    return "failed";
  }
}

// The real container process: stream the PDF to the engine's /process, pass the
// Mistral key over the internal binding, parse the artifacts JSON.
function realProcess(env: Env): ProcessFn {
  return async (pdf, job) => {
    const engine = env.OCR_ENGINE.getByName("engine");
    const qs = new URLSearchParams({ mode: job.mode });
    if (job.title) qs.set("title", job.title);
    const res = await engine.fetch(
      new Request(`http://engine/process?${qs.toString()}`, {
        method: "POST",
        headers: {
          "content-type": "application/pdf",
          "x-mistral-key": env.MISTRAL_API_KEY,
        },
        body: pdf,
      })
    );
    if (!res.ok) throw new Error(`engine /process ${res.status}`);
    return (await res.json()) as Awaited<ReturnType<ProcessFn>>;
  };
}

export async function handleQueue(
  batch: MessageBatch<{ jobId: string }>,
  env: Env
): Promise<void> {
  const process = realProcess(env);
  for (const msg of batch.messages) {
    // finalizeJob owns the clean fail path (failJob + releaseHold). A "failed"
    // or "skipped" result is fully handled, so ack it and do NOT throw: throwing
    // would trigger an infra retry we do not want after a clean outcome. Only
    // unexpected infra errors (e.g. R2/D1 unreachable) bubble up to retry.
    await finalizeJob(env, msg.body.jobId, process);
    msg.ack();
  }
}
