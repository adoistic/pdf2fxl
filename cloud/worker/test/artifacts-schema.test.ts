import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createUser } from "./helpers";

describe("artifacts schema", () => {
  it("adds nullable figures prefix and finished_at, defaulting null", async () => {
    const userId = await createUser();
    await env.DB.prepare(
      "INSERT INTO jobs (id, user_id, mode, r2_upload_key) VALUES ('a1', ?1, 'reflow', 'uploads/x/a1.pdf')"
    ).bind(userId).run();
    const row = await env.DB.prepare(
      "SELECT r2_figures_prefix, finished_at FROM jobs WHERE id = 'a1'"
    ).first<{ r2_figures_prefix: string | null; finished_at: string | null }>();
    expect(row!.r2_figures_prefix).toBeNull();
    expect(row!.finished_at).toBeNull();
  });
});
