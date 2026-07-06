import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("r2 binding", () => {
  it("round-trips an object", async () => {
    await env.STORE.put("uploads/test/echo.pdf", "hello");
    const obj = await env.STORE.get("uploads/test/echo.pdf");
    expect(await obj!.text()).toBe("hello");
  });
});
