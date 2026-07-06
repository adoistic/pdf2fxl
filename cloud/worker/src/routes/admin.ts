import { Hono } from "hono";
import type { AppUser, Env } from "../types";
import { allocate, getBalanceMcr, MCR_PER_CREDIT } from "../ledger";

export const admin = new Hono<{ Bindings: Env; Variables: { user: AppUser } }>();

admin.post("/credits", async (c) => {
  const body = await c.req
    .json<{ email?: unknown; credits?: unknown; note?: unknown }>()
    .catch(() => null);
  const email = typeof body?.email === "string" ? body.email.toLowerCase().trim() : "";
  const credits = typeof body?.credits === "number" ? body.credits : Number.NaN;
  const note = typeof body?.note === "string" ? body.note : null;
  if (
    !email.includes("@") ||
    !Number.isFinite(credits) ||
    credits === 0 ||
    Math.abs(credits) > 1_000_000
  ) {
    return c.json({ error: "invalid request" }, 400);
  }
  const userRow = await c.env.DB.prepare(
    "INSERT INTO users (email) VALUES (?1) ON CONFLICT(email) DO UPDATE SET email = excluded.email RETURNING id"
  )
    .bind(email)
    .first<{ id: number }>();
  await allocate(c.env.DB, {
    userId: userRow!.id,
    amountMcr: Math.round(credits * MCR_PER_CREDIT),
    note,
    createdBy: c.get("user").email,
  });
  const balanceMcr = await getBalanceMcr(c.env.DB, userRow!.id);
  return c.json({ email, balanceMcr, balance: balanceMcr / MCR_PER_CREDIT });
});

admin.get("/users", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.is_admin, COALESCE(SUM(l.amount_mcr), 0) AS balance_mcr
     FROM users u
     LEFT JOIN credit_ledger l ON l.user_id = u.id
     GROUP BY u.id
     ORDER BY u.id DESC`
  ).all<{ id: number; email: string; name: string | null; is_admin: number; balance_mcr: number }>();
  return c.json({
    users: results.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      isAdmin: r.is_admin === 1,
      balance: r.balance_mcr / MCR_PER_CREDIT,
    })),
  });
});

admin.get("/users/:id/ledger", async (c) => {
  const userId = Number(c.req.param("id"));
  if (!Number.isInteger(userId)) return c.json({ error: "not found" }, 404);
  const exists = await c.env.DB.prepare("SELECT id FROM users WHERE id = ?1")
    .bind(userId)
    .first<{ id: number }>();
  if (!exists) return c.json({ error: "not found" }, 404);
  const { results } = await c.env.DB.prepare(
    `SELECT kind, amount_mcr, job_id, ref_id, note, created_by, created_at
     FROM credit_ledger WHERE user_id = ?1 ORDER BY id DESC`
  )
    .bind(userId)
    .all<{
      kind: string;
      amount_mcr: number;
      job_id: string | null;
      ref_id: number | null;
      note: string | null;
      created_by: string | null;
      created_at: string;
    }>();
  return c.json({
    entries: results.map((r) => ({
      kind: r.kind,
      amountMcr: r.amount_mcr,
      jobId: r.job_id,
      refId: r.ref_id,
      note: r.note,
      createdBy: r.created_by,
      createdAt: r.created_at,
    })),
  });
});
