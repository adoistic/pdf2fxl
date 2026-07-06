import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createUser } from "./helpers";

describe("jobs schema", () => {
  it("has the jobs table with defaults", async () => {
    const userId = await createUser();
    await env.DB.prepare(
      "INSERT INTO jobs (id, user_id, mode, r2_upload_key) VALUES ('j1', ?1, 'reflow', 'uploads/x/j1.pdf')"
    ).bind(userId).run();
    const row = await env.DB.prepare("SELECT * FROM jobs WHERE id = 'j1'").first<Record<string, unknown>>();
    expect(row!.status).toBe("received");
    expect(row!.express).toBe(0);
    expect(row!.page_count).toBeNull();
    expect(row!.hold_id).toBeNull();
  });

  it("rejects invalid mode and status", async () => {
    const userId = await createUser();
    await expect(
      env.DB.prepare("INSERT INTO jobs (id, user_id, mode) VALUES ('j2', ?1, 'sideways')").bind(userId).run()
    ).rejects.toThrow(/CHECK/);
    await expect(
      env.DB.prepare(
        "INSERT INTO jobs (id, user_id, mode, status) VALUES ('j3', ?1, 'reflow', 'daydreaming')"
      ).bind(userId).run()
    ).rejects.toThrow(/CHECK/);
  });
});
