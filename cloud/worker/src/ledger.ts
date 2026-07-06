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
  if (!Number.isInteger(opts.amountMcr) || opts.amountMcr === 0) {
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
export async function placeHold(
  db: D1Database,
  opts: { userId: number; jobId: string; amountMcr: number }
): Promise<HoldResult> {
  if (!Number.isInteger(opts.amountMcr) || opts.amountMcr <= 0) {
    throw new Error("hold amount must be a positive integer");
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
