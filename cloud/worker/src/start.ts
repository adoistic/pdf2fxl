import { placeHold, releaseHold } from "./ledger";
import { failJob, getJobForUser, transition } from "./jobs";

const MAX_PAGES = 100_000; // a 100MB upload cannot plausibly exceed this

// The engine callback is injected so tests never need a running container:
// the route passes the real container fetch, tests pass stubs.
export type EnginePrepare = (pdf: ArrayBuffer) => Promise<{ pageCount: number }>;

export type StartResult =
  | { ok: true; pageCount: number; heldMcr: number }
  | { ok: false; reason: "not_startable" | "insufficient_credits" | "engine_error" | "not_found" };

export type CountResult =
  | { ok: true; pageCount: number; rateMcr: number; creditsMcr: number }
  | { ok: false; reason: "not_countable" | "engine_error" | "not_found" };

// Single-tier pricing: one rate per mode, no express surcharge (removed 2026-07-06;
// all OCR runs the same way and users never see a tier choice).
async function rateFor(db: D1Database, mode: string): Promise<number> {
  const key = mode === "fixed" ? "rate_fixed_mcr" : "rate_reflow_mcr";
  const row = await db
    .prepare("SELECT value FROM config WHERE key = ?1")
    .bind(key)
    .first<{ value: string }>();
  return Number(row?.value);
}

// Per-page surcharge for the emphasis add-on (0 when the job did not opt in).
async function enrichRateFor(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT value FROM config WHERE key = 'rate_enrich_mcr'")
    .first<{ value: string }>();
  return Number(row?.value);
}

export async function startJob(
  db: D1Database,
  store: R2Bucket,
  prepare: EnginePrepare,
  jobId: string,
  userId: number
): Promise<StartResult> {
  const job = await getJobForUser(db, jobId, userId);
  if (!job) return { ok: false, reason: "not_found" };
  if (!(await transition(db, jobId, "received", "preparing"))) {
    return { ok: false, reason: "not_startable" };
  }

  let pageCount: number;
  // Bulk counts pages first (POST /count) and stores it, so a second /prepare is
  // wasteful. Reuse a stored, validated page_count when present; otherwise count now.
  if (job.pageCount != null && Number.isSafeInteger(job.pageCount) && job.pageCount > 0) {
    pageCount = job.pageCount;
  } else {
    try {
      const obj = await store.get(job.r2UploadKey!);
      if (!obj) throw new Error(`upload missing in R2: ${job.r2UploadKey}`);
      const res = await prepare(await obj.arrayBuffer());
      pageCount = res.pageCount;
      if (!Number.isSafeInteger(pageCount) || pageCount <= 0) {
        throw new Error(`engine returned page_count ${pageCount}`);
      }
    } catch (err) {
      await failJob(db, jobId, "preparing", "we could not read this file", String(err));
      return { ok: false, reason: "engine_error" };
    }
  }

  if (pageCount > MAX_PAGES) {
    await failJob(db, jobId, "preparing", "we could not read this file", `page_count ${pageCount} exceeds cap`);
    return { ok: false, reason: "engine_error" };
  }

  const rateMcr = await rateFor(db, job.mode);
  // Surcharge: reuse the snapshot from count when present, else the live rate
  // (single-file start skips count). The same value is both held and stored, so
  // the hold and any later refund always agree.
  const enrichRateMcr = job.enrich ? (job.enrichRateMcr ?? await enrichRateFor(db)) : 0;
  const amountMcr = (rateMcr + enrichRateMcr) * pageCount;
  if (!Number.isSafeInteger(rateMcr) || rateMcr <= 0
      || !Number.isSafeInteger(enrichRateMcr) || enrichRateMcr < 0
      || !Number.isSafeInteger(amountMcr) || amountMcr <= 0) {
    await failJob(
      db, jobId, "preparing",
      "something went wrong on our side, please try again later",
      `bad pricing: rate ${rateMcr}, surcharge ${enrichRateMcr}, pages ${pageCount}`
    );
    return { ok: false, reason: "engine_error" };
  }

  // The cron sweep (plan 3) must find orphan holds via credit_ledger.job_id,
  // not jobs.hold_id, because a crash can occur between placeHold and the
  // transition below that records hold_id.
  const hold = await placeHold(db, { userId, jobId, amountMcr });
  if (!hold.ok) {
    await failJob(
      db, jobId, "preparing",
      "not enough credits for this document", `needed ${amountMcr} mcr`
    );
    return { ok: false, reason: "insufficient_credits" };
  }

  const promoted = await transition(db, jobId, "preparing", "processing", {
    page_count: pageCount, rate_mcr: rateMcr, enrich_rate_mcr: enrichRateMcr, hold_id: hold.holdId,
  });
  if (!promoted) {
    // Someone else moved the job (e.g. a future stale-sweep). Do not keep a
    // hold on a job we no longer control.
    await releaseHold(db, hold.holdId);
    return { ok: false, reason: "not_startable" };
  }
  return { ok: true, pageCount, heldMcr: amountMcr };
}

// Record the page count and rate on a still-received job without charging. Guarded
// on status='received' and page_count IS NULL so it is idempotent and never
// overwrites a job already in flight.
async function recordCount(
  db: D1Database, jobId: string, userId: number, pageCount: number, rateMcr: number, enrichRateMcr: number
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE jobs SET page_count = ?1, rate_mcr = ?2, enrich_rate_mcr = ?3, updated_at = datetime('now')
       WHERE id = ?4 AND user_id = ?5 AND status = 'received' AND page_count IS NULL`
    )
    .bind(pageCount, rateMcr, enrichRateMcr, jobId, userId)
    .run();
  return res.meta.changes === 1;
}

// Count a job's pages up front and store the cost, placing NO hold. The bulk flow
// counts every book first so the whole batch can be priced and gated against the
// balance before any credits are committed. Idempotent: a job already counted
// returns its stored figures.
export async function countJob(
  db: D1Database,
  store: R2Bucket,
  prepare: EnginePrepare,
  jobId: string,
  userId: number
): Promise<CountResult> {
  const job = await getJobForUser(db, jobId, userId);
  if (!job) return { ok: false, reason: "not_found" };
  if (job.pageCount != null && job.rateMcr != null) {
    // Total per-page cost includes the emphasis surcharge snapshotted at count.
    const totalMcr = job.rateMcr + (job.enrichRateMcr ?? 0);
    return {
      ok: true, pageCount: job.pageCount, rateMcr: job.rateMcr,
      creditsMcr: totalMcr * job.pageCount,
    };
  }
  if (job.status !== "received") return { ok: false, reason: "not_countable" };

  let pageCount: number;
  try {
    const obj = await store.get(job.r2UploadKey!);
    if (!obj) throw new Error(`upload missing in R2: ${job.r2UploadKey}`);
    const res = await prepare(await obj.arrayBuffer());
    pageCount = res.pageCount;
    if (!Number.isSafeInteger(pageCount) || pageCount <= 0 || pageCount > MAX_PAGES) {
      throw new Error(`engine returned page_count ${pageCount}`);
    }
  } catch (err) {
    await failJob(db, jobId, "received", "we could not read this file", String(err));
    return { ok: false, reason: "engine_error" };
  }

  const rateMcr = await rateFor(db, job.mode);
  const enrichRateMcr = job.enrich ? await enrichRateFor(db) : 0;
  if (!Number.isSafeInteger(rateMcr) || rateMcr <= 0
      || !Number.isSafeInteger(enrichRateMcr) || enrichRateMcr < 0) {
    await failJob(db, jobId, "received",
      "something went wrong on our side, please try again later",
      `bad rate ${rateMcr}/${enrichRateMcr}`);
    return { ok: false, reason: "engine_error" };
  }
  await recordCount(db, jobId, userId, pageCount, rateMcr, enrichRateMcr);
  return { ok: true, pageCount, rateMcr, creditsMcr: (rateMcr + enrichRateMcr) * pageCount };
}
