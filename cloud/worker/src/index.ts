import { Hono } from "hono";
import type { AppUser, Env } from "./types";
import { authRequired } from "./auth";
import { getBalanceMcr, MCR_PER_CREDIT } from "./ledger";

const app = new Hono<{ Bindings: Env; Variables: { user: AppUser } }>();

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/config", (c) =>
  c.json({
    productName: "Thothica OCR",
    firebaseProjectId: c.env.FIREBASE_PROJECT_ID || null,
  })
);

app.use("/api/me", authRequired);
app.get("/api/me", async (c) => {
  const user = c.get("user");
  const balanceMcr = await getBalanceMcr(c.env.DB, user.id);
  return c.json({
    email: user.email,
    name: user.name,
    isAdmin: user.isAdmin,
    balanceMcr,
    balance: balanceMcr / MCR_PER_CREDIT,
  });
});

export default app;
