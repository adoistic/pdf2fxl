import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import app from "../src/index";

describe("health", () => {
  it("responds ok without auth", async () => {
    const res = await app.request("/api/health", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("exposes public config without vendor names", async () => {
    const res = await app.request("/api/config", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { productName: string; firebaseProjectId: string | null };
    expect(body.productName).toBe("Thothica OCR");
    expect(body.firebaseProjectId).toBe("test-project");
    expect(JSON.stringify(body)).not.toMatch(/mistral|pdf2fxl/i);
  });
});
