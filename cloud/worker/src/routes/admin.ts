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
