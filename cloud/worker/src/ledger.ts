// Append-only credit ledger. All amounts are integer milli-credits
// (1 credit = 1000 mcr). Balance is always SUM(amount_mcr) for the user;
// there is no stored balance column to drift out of sync.

export const MCR_PER_CREDIT = 1000;

export async function getBalanceMcr(db: D1Database, userId: number): Promise<number> {
  const row = await db
    .prepare("SELECT COALESCE(SUM(amount_mcr), 0) AS balance FROM credit_ledger WHERE user_id = ?1")
    .bind(userId)
    .first<{ balance: number }>();
  return row?.balance ?? 0;
}

export async function allocate(
  db: D1Database,
  opts: { userId: number; amountMcr: number; note: string | null; createdBy: string }
): Promise<number> {
  if (!Number.isSafeInteger(opts.amountMcr) || opts.amountMcr === 0) {
    throw new Error("allocation must be a non-zero integer amount");
  }
  const row = await db
    .prepare(
      "INSERT INTO credit_ledger (user_id, kind, amount_mcr, note, created_by) VALUES (?1, 'allocation', ?2, ?3, ?4) RETURNING id"
    )
    .bind(opts.userId, opts.amountMcr, opts.note, opts.createdBy)
    .first<{ id: number }>();
  return row!.id;
}

export type HoldResult =
  | { ok: true; holdId: number }
  | { ok: false; reason: "insufficient_credits" };

// Single-statement check-and-insert: the SELECT computes the balance and the
// INSERT only happens when it covers the hold. D1 executes the statement
// atomically, so two concurrent holds cannot both pass a balance that only
// covers one of them.
// One-active-hold-per-job is deliberately the jobs table's concern: the ledger is append-only, so a unique index on job_id here would forbid legitimate re-holds after a release. placeHold is NOT idempotent; callers must gate it on job state.
export async function placeHold(
  db: D1Database,
  opts: { userId: number; jobId: string; amountMcr: number }
): Promise<HoldResult> {
  if (!Number.isSafeInteger(opts.amountMcr) || opts.amountMcr <= 0) {
    throw new Error("hold amount must be a positive integer");
  }
  if (!opts.jobId) {
    throw new Error("hold requires a job id");
  }
  const row = await db
    .prepare(
      `INSERT INTO credit_ledger (user_id, kind, amount_mcr, job_id)
       SELECT ?1, 'hold', ?2, ?3
       WHERE (SELECT COALESCE(SUM(amount_mcr), 0) FROM credit_ledger WHERE user_id = ?1) >= ?4
       RETURNING id`
    )
    .bind(opts.userId, -opts.amountMcr, opts.jobId, opts.amountMcr)
    .first<{ id: number }>();
  return row ? { ok: true, holdId: row.id } : { ok: false, reason: "insufficient_credits" };
}

// Settlement rows reference their hold via ref_id. The partial unique index
// ux_ledger_settlement lets exactly one settlement row exist per hold, so a
// concurrent capture and release cannot both succeed; the loser hits the
// UNIQUE constraint and reports false.

function isUniqueViolation(err: unknown): boolean {
  // Pinned to the settlement index: a future unique index on this table must
  // not have its violations silently read as "already settled".
  return String(err).includes("UNIQUE constraint failed: credit_ledger.ref_id");
}

// Capture: the job delivered. The hold's negative amount stands as the final
// charge; the capture row is a zero-amount marker that locks the hold.
//
// Returns false as a no-op for three cases the caller must not conflate blindly:
// the hold was already settled (either way), or the id is not a hold row.
// A finalizer retrying after a timeout must disambiguate via:
//   SELECT kind FROM credit_ledger WHERE ref_id = ?1 AND kind IN ('capture','release')
// before deciding whether the job was delivered or refunded.
export async function captureHold(db: D1Database, holdId: number): Promise<boolean> {
  try {
    const res = await db
      .prepare(
        `INSERT INTO credit_ledger (user_id, kind, amount_mcr, job_id, ref_id)
         SELECT user_id, 'capture', 0, job_id, id
         FROM credit_ledger WHERE id = ?1 AND kind = 'hold'`
      )
      .bind(holdId)
      .run();
    return res.meta.changes === 1;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

// Release: the job failed or was cancelled. Insert the exact opposite of the
// hold amount, refunding it in full.
//
// Returns false as a no-op for three cases the caller must not conflate blindly:
// the hold was already settled (either way), or the id is not a hold row.
// A finalizer retrying after a timeout must disambiguate via:
//   SELECT kind FROM credit_ledger WHERE ref_id = ?1 AND kind IN ('capture','release')
// before deciding whether the job was delivered or refunded.
export async function releaseHold(db: D1Database, holdId: number): Promise<boolean> {
  try {
    const res = await db
      .prepare(
        `INSERT INTO credit_ledger (user_id, kind, amount_mcr, job_id, ref_id)
         SELECT user_id, 'release', -amount_mcr, job_id, id
         FROM credit_ledger WHERE id = ?1 AND kind = 'hold'`
      )
      .bind(holdId)
      .run();
    return res.meta.changes === 1;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

// Refund part of a settled surcharge: the emphasis add-on charges up front but
// only earns per enriched page, so finalize returns the surcharge for pages that
// were not enriched. Represented as a positive 'allocation' row by 'system'
// (the ledger has no 'refund' kind and rebuilding the money table is not worth
// the risk). Two guards make it correct:
//   - EXISTS(capture for the hold): only refund a hold that was CAPTURED. If the
//     hold was released instead (job failed/cancelled), the full amount incl. the
//     surcharge was already returned, so a second refund would double-pay.
//   - NOT EXISTS(prior system refund for the job) + the ux_ledger_system_refund
//     unique index: fires at most once, surviving finalize retries and a crash
//     between capture and this insert.
export async function refundSurcharge(
  db: D1Database,
  opts: { userId: number; jobId: string; holdId: number; amountMcr: number; note: string }
): Promise<boolean> {
  if (!Number.isSafeInteger(opts.amountMcr) || opts.amountMcr <= 0) return false;
  try {
    const res = await db
      .prepare(
        `INSERT INTO credit_ledger (user_id, kind, amount_mcr, job_id, note, created_by)
         SELECT ?1, 'allocation', ?2, ?3, ?4, 'system'
         WHERE EXISTS (SELECT 1 FROM credit_ledger WHERE ref_id = ?5 AND kind = 'capture')
           AND NOT EXISTS (SELECT 1 FROM credit_ledger
                           WHERE job_id = ?3 AND kind = 'allocation' AND created_by = 'system')`
      )
      .bind(opts.userId, opts.amountMcr, opts.jobId, opts.note, opts.holdId)
      .run();
    return res.meta.changes === 1;
  } catch (err) {
    // The unique index backstops true concurrency; a violation means another
    // finalize already refunded this job.
    if (String(err).includes("UNIQUE constraint failed: credit_ledger.job_id")) return false;
    throw err;
  }
}

export type Settlement = { kind: "capture" | "release"; id: number } | null;

// How a hold was settled, if at all. This is the disambiguation the comments
// above point finalizers at: after a false from captureHold/releaseHold, this
// tells "already captured (job delivered)" from "already released (refunded)".
export async function getSettlement(db: D1Database, holdId: number): Promise<Settlement> {
  const row = await db
    .prepare(
      "SELECT id, kind FROM credit_ledger WHERE ref_id = ?1 AND kind IN ('capture', 'release')"
    )
    .bind(holdId)
    .first<{ id: number; kind: "capture" | "release" }>();
  return row ? { kind: row.kind, id: row.id } : null;
}
