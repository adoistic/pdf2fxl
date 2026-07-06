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
