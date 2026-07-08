import { Hono } from "hono";
import type { AppUser, Env } from "./types";
import { adminRequired, authRequired } from "./auth";
import { getBalanceMcr, MCR_PER_CREDIT } from "./ledger";
import { admin } from "./routes/admin";
import { jobs } from "./routes/jobs";
import { translate } from "./routes/translate";
import { branding } from "./routes/branding";
import { handleQueue } from "./finalize";
import { r2DirectEnabled } from "./presign";
import { enrichConfig } from "./enrich";
import { translateConfig } from "./translate";
import { getBranding } from "./branding";

const app = new Hono<{ Bindings: Env; Variables: { user: AppUser } }>();

app.onError((err, c) => {
  console.error("unhandled error", err);
  return c.json({ error: "something went wrong" }, 500);
});

// Only /api/* reaches the Worker first (run_worker_first); other paths are
// served by Workers Assets. So this JSON envelope applies to API misses only.
app.notFound((c) => c.json({ error: "not found" }, 404));

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/config", async (c) => {
  const enrich = await enrichConfig(c.env);
  return c.json({
    productName: "Thothica OCR",
    firebaseProjectId: c.env.FIREBASE_PROJECT_ID || null,
    r2Direct: r2DirectEnabled(c.env),
    enrich: { available: enrich.available, rateCredits: enrich.rateCredits },
  });
});

app.use("/api/me", authRequired);
app.get("/api/me", async (c) => {
  const user = c.get("user");
  const balanceMcr = await getBalanceMcr(c.env.DB, user.id);
  // Hidden add-ons are invisible unless the admin flipped this user's flags;
  // only then does /api/me carry their payloads (terms / current branding).
  let translate = null;
  let brandingPayload = null;
  const flags = await c.env.DB
    .prepare("SELECT translate_enabled, branding_enabled FROM users WHERE id = ?1")
    .bind(user.id)
    .first<{ translate_enabled: number; branding_enabled: number }>();
  if (flags?.translate_enabled === 1) {
    const cfg = await translateConfig(c.env);
    if (cfg.available) {
      translate = {
        maxWords: cfg.maxWords,
        blockWords: cfg.blockWords,
        blockCredits: cfg.blockMcr / MCR_PER_CREDIT,
      };
    }
  }
  if (flags?.branding_enabled === 1) {
    brandingPayload = await getBranding(c.env.DB, user.id);
  }
  return c.json({
    email: user.email,
    name: user.name,
    isAdmin: user.isAdmin,
    balanceMcr,
    balance: balanceMcr / MCR_PER_CREDIT,
    translate,
    branding: brandingPayload,
  });
});

app.use("/api/jobs", authRequired);
app.use("/api/jobs/*", authRequired);
app.route("/api/jobs", jobs);

app.use("/api/translate", authRequired);
app.use("/api/translate/*", authRequired);
app.route("/api/translate", translate);

app.use("/api/branding", authRequired);
app.use("/api/branding/*", authRequired);
app.route("/api/branding", branding);

app.use("/api/admin/*", authRequired, adminRequired);
app.route("/api/admin", admin);

// A Worker with a queue consumer needs a default export object with both fetch
// and queue handlers. The Hono app is exported named so route tests can still
// call app.request(...).
export { app };
export default { fetch: app.fetch, queue: handleQueue };
export { OcrEngine } from "./container";
