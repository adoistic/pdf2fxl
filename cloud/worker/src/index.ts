import { Hono } from "hono";
import type { AppUser, Env } from "./types";
import { adminRequired, authRequired } from "./auth";
import { getBalanceMcr, MCR_PER_CREDIT } from "./ledger";
import { admin } from "./routes/admin";
import { jobs } from "./routes/jobs";

const app = new Hono<{ Bindings: Env; Variables: { user: AppUser } }>();

app.onError((err, c) => {
  console.error("unhandled error", err);
  return c.json({ error: "something went wrong" }, 500);
});

// Only /api/* reaches the Worker first (run_worker_first); other paths are
// served by Workers Assets. So this JSON envelope applies to API misses only.
app.notFound((c) => c.json({ error: "not found" }, 404));

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

app.use("/api/jobs", authRequired);
app.use("/api/jobs/*", authRequired);
app.route("/api/jobs", jobs);

app.use("/api/admin/*", authRequired, adminRequired);
app.route("/api/admin", admin);

export default app;
