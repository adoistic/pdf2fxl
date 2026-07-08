import { Hono } from "hono";
import type { AppUser, Env } from "../types";
import {
  brandingEnabled,
  clearLogo,
  getBranding,
  logoKeyFor,
  putBranding,
  resetBranding,
  setLogo,
  validatePatch,
  type BrandingPatch,
} from "../branding";

type Ctx = { Bindings: Env; Variables: { user: AppUser } };

export const branding = new Hono<Ctx>();

// Per-user gate, same discipline as the translation add-on: everything
// answers 404 (never 403) unless the admin flipped this user's flag, so the
// option's existence is never revealed to anyone it is not enabled for.
branding.use("*", async (c, next) => {
  if (!(await brandingEnabled(c.env.DB, c.get("user").id))) {
    return c.json({ error: "not found" }, 404);
  }
  await next();
});

branding.get("/", async (c) => {
  return c.json(await getBranding(c.env.DB, c.get("user").id));
});

branding.put("/", async (c) => {
  const body = await c.req.json<BrandingPatch>().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid request" }, 400);
  }
  const patch: BrandingPatch = {
    brandColor: body.brandColor,
    accentColor: body.accentColor,
    backgroundColor: body.backgroundColor,
    font: body.font,
  };
  const problem = validatePatch(patch);
  if (problem) return c.json({ error: problem }, 400);
  return c.json(await putBranding(c.env.DB, c.get("user").id, patch));
});

// Back to the standard look: drop the row and the stored logo.
branding.delete("/", async (c) => {
  const userId = c.get("user").id;
  await c.env.STORE.delete(logoKeyFor(userId));
  await resetBranding(c.env.DB, userId);
  return c.json(await getBranding(c.env.DB, userId));
});

// SVG is deliberately excluded: served back from our origin it could carry
// scripts. Raster images only, capped small (a header logo, not a poster).
const LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
export const MAX_LOGO_BYTES = 1024 * 1024;

branding.post("/logo", async (c) => {
  const userId = c.get("user").id;
  const contentType = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!LOGO_TYPES.has(contentType)) {
    return c.json({ error: "the logo must be a PNG, JPEG, or WebP image" }, 415);
  }
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > MAX_LOGO_BYTES) {
    return c.json({ error: "the logo must be under 1 MB" }, 413);
  }
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength === 0) return c.json({ error: "attach the image as the request body" }, 400);
  if (bytes.byteLength > MAX_LOGO_BYTES) {
    return c.json({ error: "the logo must be under 1 MB" }, 413);
  }
  const key = logoKeyFor(userId);
  await c.env.STORE.put(key, bytes, { httpMetadata: { contentType } });
  await setLogo(c.env.DB, userId, key, contentType);
  return c.json(await getBranding(c.env.DB, userId));
});

// The logo streams back through the Worker (an <img> cannot carry the bearer
// token, so the client fetches this with auth and uses a blob url).
branding.get("/logo", async (c) => {
  const userId = c.get("user").id;
  const current = await getBranding(c.env.DB, userId);
  if (!current.hasLogo) return c.json({ error: "not found" }, 404);
  const obj = await c.env.STORE.get(logoKeyFor(userId));
  if (!obj) return c.json({ error: "not found" }, 404);
  return new Response(obj.body as BodyInit, {
    headers: {
      "content-type": current.logoType ?? "application/octet-stream",
      "cache-control": "private, max-age=300",
    },
  });
});

branding.delete("/logo", async (c) => {
  const userId = c.get("user").id;
  await c.env.STORE.delete(logoKeyFor(userId));
  await clearLogo(c.env.DB, userId);
  return c.json(await getBranding(c.env.DB, userId));
});
