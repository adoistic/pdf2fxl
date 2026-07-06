import { placeHold, releaseHold } from "./ledger";
import { failJob, getJobForUser, transition } from "./jobs";

const MAX_PAGES = 100_000; // a 100MB upload cannot plausibly exceed this

// The engine callback is injected so tests never need a running container:
// the route passes the real container fetch, tests pass stubs.
export type EnginePrepare = (pdf: ArrayBuffer) => Promise<{ pageCount: number }>;

export type StartResult =
  | { ok: true; pageCount: number; heldMcr: number }
  | { ok: false; reason: "not_startable" | "insufficient_credits" | "engine_error" | "not_found" };

async function rateFor(db: D1Database, mode: string, express: boolean): Promise<number> {
  const keys = mode === "fixed" ? "rate_fixed_mcr" : "rate_reflow_mcr";
  const { results } = await db
    .prepare("SELECT key, value FROM config WHERE key IN (?1, 'express_surcharge_mcr')")
    .bind(keys)
    .all<{ key: string; value: string }>();
  const cfg = Object.fromEntries(results.map((r) => [r.key, Number(r.value)]));
  return cfg[keys] + (express ? cfg.express_surcharge_mcr : 0);
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

  if (pageCount > MAX_PAGES) {
    await failJob(db, jobId, "preparing", "we could not read this file", `page_count ${pageCount} exceeds cap`);
    return { ok: false, reason: "engine_error" };
  }

  const rateMcr = await rateFor(db, job.mode, job.express);
  const amountMcr = rateMcr * pageCount;
  if (!Number.isSafeInteger(rateMcr) || rateMcr <= 0 || !Number.isSafeInteger(amountMcr) || amountMcr <= 0) {
    await failJob(
      db, jobId, "preparing",
      "something went wrong on our side, please try again later",
      `bad pricing: rate ${rateMcr}, pages ${pageCount}`
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
    page_count: pageCount, rate_mcr: rateMcr, hold_id: hold.holdId,
  });
  if (!promoted) {
    // Someone else moved the job (e.g. a future stale-sweep). Do not keep a
    // hold on a job we no longer control.
    await releaseHold(db, hold.holdId);
    return { ok: false, reason: "not_startable" };
  }
  return { ok: true, pageCount, heldMcr: amountMcr };
}
