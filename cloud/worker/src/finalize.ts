import type { Env, QueueMsg } from "./types";
import { captureHold, releaseHold, refundSurcharge } from "./ledger";
import { failJob, transition, type Job } from "./jobs";
import { r2DirectEnabled, presignGet } from "./presign";
import { enrichConfig } from "./enrich";
import { translateConfig, translateKey } from "./translate";
import { failTranslation, getTranslation, transitionTranslation, type Translation } from "./translations";
import { cleanupUpload } from "./sweep";

// The container call is injected so tests need no container or Mistral: the
// queue handler passes the real container fetch, tests pass a stub returning
// fixture artifacts.
//
// The input is either the PDF bytes (streaming fallback) or, when R2-direct is
// on, a presigned GET url the container fetches straight from R2. finalizeJob
// picks which; the injected fn just forwards whichever it is given.
export type ProcessInput =
  | { kind: "stream"; body: ReadableStream<Uint8Array> | ArrayBuffer }
  | { kind: "url"; inputUrl: string };

export type ProcessFn = (
  input: ProcessInput,
  job: Job
) => Promise<{
  page_count: number;
  verbatim: unknown[];
  doc_json: unknown;
  markdown: string;
  figures: { name: string; base64: string }[];
  // Present only when the emphasis add-on ran. pages_enriched drives the
  // per-page surcharge refund at finalize.
  enrich?: { requested: boolean; pages_total: number; pages_enriched: number };
}>;

type FinalizeRow = {
  id: string; user_id: number; mode: Job["mode"]; express: number; enrich: number; status: Job["status"];
  title: string | null; page_count: number | null; rate_mcr: number | null; enrich_rate_mcr: number | null;
  hold_id: number | null; r2_upload_key: string | null; error_public: string | null;
  created_at: string;
};

function toJob(r: FinalizeRow): Job {
  return {
    id: r.id, userId: r.user_id, bulkId: null, mode: r.mode, express: r.express === 1,
    enrich: r.enrich === 1, status: r.status, title: r.title, pageCount: r.page_count,
    rateMcr: r.rate_mcr, enrichRateMcr: r.enrich_rate_mcr,
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
      `SELECT id, user_id, mode, express, enrich, status, title, page_count, rate_mcr,
              enrich_rate_mcr, hold_id, r2_upload_key, error_public, created_at
       FROM jobs WHERE id = ?1`
    )
    .bind(jobId)
    .first<FinalizeRow>();
  if (!row) return "skipped";
  const job = toJob(row);
  if (job.status !== "processing") return "skipped";

  // R2-direct only needs to know the upload exists (it passes a presigned url,
  // not the bytes), so a head() avoids opening an undrained object body. The
  // streaming fallback needs the body, so it does a full get().
  const direct = r2DirectEnabled(env);
  const upload = job.r2UploadKey
    ? direct
      ? await env.STORE.head(job.r2UploadKey)
      : await env.STORE.get(job.r2UploadKey)
    : null;
  if (!upload) {
    await failJob(env.DB, jobId, "processing", "we could not read this file", "upload gone");
    if (job.holdId != null) await releaseHold(env.DB, job.holdId);
    return "failed";
  }

  try {
    // R2-direct: hand the container a presigned GET url so it fetches the PDF
    // straight from R2 (the bytes never transit the Worker). Fallback: stream
    // the R2 object body straight through, so the Worker still never buffers the
    // whole PDF in its isolate. Either way the upload object must exist (checked
    // above), so an expired presign or missing object fails cleanly downstream.
    const input: ProcessInput = direct
      ? { kind: "url", inputUrl: await presignGet(env, job.r2UploadKey!) }
      : { kind: "stream", body: (upload as R2ObjectBody).body };
    const out = await process(input, job);

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

    if (job.holdId != null) {
      await captureHold(env.DB, job.holdId);
      // Per-page surcharge refund: the emphasis add-on charged up front but only
      // earns per enriched page. Uses the snapshot enrich_rate_mcr (never live
      // config) so hold and refund agree; NaN-safe if the summary is missing.
      const surcharge = job.enrichRateMcr ?? 0;
      if (surcharge > 0) {
        const total = job.pageCount ?? 0;
        const enriched = Math.max(0, Math.min(total, Number(out.enrich?.pages_enriched ?? 0)));
        const refundMcr = surcharge * (total - enriched);
        if (refundMcr > 0) {
          await refundSurcharge(env.DB, {
            userId: job.userId, jobId, holdId: job.holdId, amountMcr: refundMcr,
            note: `emphasis surcharge refund: ${total - enriched}/${total} pages`,
          });
        }
      }
    }
    await transition(env.DB, jobId, "processing", "ready");
    // The original PDF serves nothing once results exist and only costs
    // storage: a delayed message deletes it ~10 minutes after delivery.
    // Best-effort here; the hourly sweep and the R2 lifecycle rule back it up.
    try {
      await env.OCR_QUEUE.send({ cleanupJobId: jobId }, { delaySeconds: 600 });
    } catch (err) {
      console.error("cleanup enqueue failed", err);
    }
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
  return async (input, job) => {
    const engine = env.OCR_ENGINE.getByName("engine");
    const qs = new URLSearchParams({ mode: job.mode });
    if (job.title) qs.set("title", job.title);
    // R2-direct: pass the presigned url and send no body; the container fetches
    // the PDF from R2 itself. Fallback: stream the bytes as the request body.
    if (input.kind === "url") qs.set("input_url", input.inputUrl);
    const headers: Record<string, string> = {
      "content-type": "application/pdf",
      "x-mistral-key": env.MISTRAL_API_KEY,
    };
    // Emphasis add-on: only send it when the job opted in AND it is fully
    // configured now. If not, the container skips the pass and the surcharge is
    // refunded in full at capture.
    if (job.enrich) {
      const enrich = await enrichConfig(env);
      if (enrich.available) {
        qs.set("enrich", "1");
        qs.set("enrich_model", enrich.model);
        headers["x-enrich-key"] = env.ENRICH_API_KEY!;
      }
    }
    const res = await engine.fetch(
      new Request(`http://engine/process?${qs.toString()}`, {
        method: "POST",
        headers,
        body: input.kind === "url" ? undefined : input.body,
      })
    );
    if (!res.ok) throw new Error(`engine /process ${res.status}`);
    return (await res.json()) as Awaited<ReturnType<ProcessFn>>;
  };
}

// ---------------------------------------------------------------------------
// Translation finalize: same shape as finalizeJob. The container call is
// injected so tests need no container or provider key.
// ---------------------------------------------------------------------------
export type TranslateInput =
  | { kind: "text"; text: string }
  | { kind: "doc"; docJson: unknown };

export type TranslateFn = (
  input: TranslateInput,
  t: Translation,
  model: string
) => Promise<{ word_count: number; markdown: string; doc_json?: unknown }>;

// Finalize one translation: read its stored source from R2, run the (injected)
// container translate, store the outputs, capture the hold, mark it ready.
// Idempotent: anything not in 'processing' is skipped; any failure releases
// the hold so the reader is never charged for a translation they did not get.
export async function finalizeTranslation(
  env: Env,
  translationId: string,
  translateFn: TranslateFn
): Promise<"ready" | "failed" | "skipped"> {
  const t = await getTranslation(env.DB, translationId);
  if (!t || t.status !== "processing") return "skipped";

  const src = t.r2SourceKey ? await env.STORE.get(t.r2SourceKey) : null;
  if (!src) {
    await failTranslation(
      env.DB, t.id, "processing",
      "something went wrong while translating, your credits were not charged",
      "source gone from R2"
    );
    if (t.holdId != null) await releaseHold(env.DB, t.holdId);
    return "failed";
  }

  try {
    const cfg = await translateConfig(env);
    if (!cfg.available) throw new Error("translate add-on unconfigured at finalize");
    const input: TranslateInput =
      t.kind === "text"
        ? { kind: "text", text: await src.text() }
        : { kind: "doc", docJson: JSON.parse(await src.text()) };
    const out = await translateFn(input, t, cfg.model);
    if (typeof out.markdown !== "string" || !out.markdown.trim()) {
      throw new Error("engine returned no translation");
    }

    const mdKey = `translations/${t.id}/normalized.md`;
    await env.STORE.put(mdKey, out.markdown, {
      httpMetadata: { contentType: "text/markdown" },
    });
    let docKey: string | null = null;
    if (t.kind === "book" && out.doc_json !== undefined) {
      docKey = `translations/${t.id}/normalized.json`;
      await env.STORE.put(docKey, JSON.stringify(out.doc_json), {
        httpMetadata: { contentType: "application/json" },
      });
    }

    const updated = await env.DB
      .prepare(
        `UPDATE translations SET r2_md_key = ?1, r2_doc_key = ?2,
           finished_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?3 AND status = 'processing'`
      )
      .bind(mdKey, docKey, t.id)
      .run();
    if (updated.meta.changes !== 1) return "skipped";

    if (t.holdId != null) await captureHold(env.DB, t.holdId);
    await transitionTranslation(env.DB, t.id, "processing", "ready");
    return "ready";
  } catch (err) {
    await failTranslation(
      env.DB, t.id, "processing",
      "something went wrong while translating, your credits were not charged",
      String(err)
    );
    if (t.holdId != null) await releaseHold(env.DB, t.holdId);
    return "failed";
  }
}

// The real container translate: the model id comes from config per run (like
// enrich) and the provider key travels in a header, never stored container-side.
function realTranslate(env: Env): TranslateFn {
  return async (input, t, model) => {
    const engine = env.OCR_ENGINE.getByName("engine");
    const body =
      input.kind === "text"
        ? { kind: "text", text: input.text, target_language: t.targetLanguage, model }
        : { kind: "doc", doc_json: input.docJson, target_language: t.targetLanguage, model };
    const res = await engine.fetch(
      new Request("http://engine/translate", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-translate-key": translateKey(env)!,
        },
        body: JSON.stringify(body),
      })
    );
    if (!res.ok) throw new Error(`engine /translate ${res.status}`);
    return (await res.json()) as Awaited<ReturnType<TranslateFn>>;
  };
}

export async function handleQueue(
  batch: MessageBatch<QueueMsg>,
  env: Env
): Promise<void> {
  const process = realProcess(env);
  for (const msg of batch.messages) {
    // finalizeJob/finalizeTranslation own the clean fail path (fail + release
    // hold). A "failed" or "skipped" result is fully handled, so ack it and do
    // NOT throw: throwing would trigger an infra retry we do not want after a
    // clean outcome. Only unexpected infra errors (e.g. R2/D1 unreachable)
    // bubble up to retry.
    if (msg.body.translationId) {
      await finalizeTranslation(env, msg.body.translationId, realTranslate(env));
    } else if (msg.body.jobId) {
      await finalizeJob(env, msg.body.jobId, process);
    } else if (msg.body.cleanupJobId) {
      await cleanupUpload(env, msg.body.cleanupJobId);
    }
    msg.ack();
  }
}
