import { Hono } from "hono";
import type { AppUser, Env } from "./types";

const app = new Hono<{ Bindings: Env; Variables: { user: AppUser } }>();

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/config", (c) =>
  c.json({
    productName: "Thothica OCR",
    firebaseProjectId: c.env.FIREBASE_PROJECT_ID || null,
  })
);

export default app;
