import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("schema", () => {
  it("has users, credit_ledger and config tables", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    ).all<{ name: string }>();
    const names = results.map((r) => r.name);
    expect(names).toContain("users");
    expect(names).toContain("credit_ledger");
    expect(names).toContain("config");
  });

  it("seeds the pricing config in milli-credits", async () => {
    const { results } = await env.DB.prepare("SELECT key, value FROM config").all<{
      key: string;
      value: string;
    }>();
    const cfg = Object.fromEntries(results.map((r) => [r.key, r.value]));
    // Pricing after migration 0006: reflow 0.7, fixed 3.0. Emphasis surcharge 0.2.
    expect(cfg.rate_reflow_mcr).toBe("700");
    expect(cfg.rate_fixed_mcr).toBe("3000");
    expect(cfg.express_surcharge_mcr).toBe("0");
    expect(cfg.rate_enrich_mcr).toBe("200");
    expect(cfg.retention_hours).toBe("72");
  });

  it("rejects a second settlement of the same hold at the schema level", async () => {
    await env.DB.prepare("INSERT INTO users (email) VALUES ('schema@test.dev')").run();
    const user = await env.DB.prepare("SELECT id FROM users WHERE email = 'schema@test.dev'").first<{ id: number }>();
    const hold = await env.DB.prepare(
      "INSERT INTO credit_ledger (user_id, kind, amount_mcr) VALUES (?1, 'hold', -700) RETURNING id"
    ).bind(user!.id).first<{ id: number }>();
    await env.DB.prepare(
      "INSERT INTO credit_ledger (user_id, kind, amount_mcr, ref_id) VALUES (?1, 'capture', 0, ?2)"
    ).bind(user!.id, hold!.id).run();
    await expect(
      env.DB.prepare(
        "INSERT INTO credit_ledger (user_id, kind, amount_mcr, ref_id) VALUES (?1, 'release', 700, ?2)"
      ).bind(user!.id, hold!.id).run()
    ).rejects.toThrow(/UNIQUE/);
  });

  it("rejects an unknown ledger kind", async () => {
    await env.DB.prepare("INSERT INTO users (email) VALUES ('schema-kind@test.dev')").run();
    const user = await env.DB.prepare("SELECT id FROM users WHERE email = 'schema-kind@test.dev'").first<{ id: number }>();
    await expect(
      env.DB.prepare(
        "INSERT INTO credit_ledger (user_id, kind, amount_mcr) VALUES (?1, 'refund', -700)"
      ).bind(user!.id).run()
    ).rejects.toThrow(/CHECK/);
  });

  it("rejects a positive hold", async () => {
    await env.DB.prepare("INSERT INTO users (email) VALUES ('schema-hold@test.dev')").run();
    const user = await env.DB.prepare("SELECT id FROM users WHERE email = 'schema-hold@test.dev'").first<{ id: number }>();
    await expect(
      env.DB.prepare(
        "INSERT INTO credit_ledger (user_id, kind, amount_mcr) VALUES (?1, 'hold', 700)"
      ).bind(user!.id).run()
    ).rejects.toThrow(/CHECK/);
  });

  it("rejects a capture with a nonzero amount", async () => {
    await env.DB.prepare("INSERT INTO users (email) VALUES ('schema-capture@test.dev')").run();
    const user = await env.DB.prepare("SELECT id FROM users WHERE email = 'schema-capture@test.dev'").first<{ id: number }>();
    const hold = await env.DB.prepare(
      "INSERT INTO credit_ledger (user_id, kind, amount_mcr) VALUES (?1, 'hold', -700) RETURNING id"
    ).bind(user!.id).first<{ id: number }>();
    await expect(
      env.DB.prepare(
        "INSERT INTO credit_ledger (user_id, kind, amount_mcr, ref_id) VALUES (?1, 'capture', 999, ?2)"
      ).bind(user!.id, hold!.id).run()
    ).rejects.toThrow(/CHECK/);
  });

  it("rejects a settlement without a hold reference", async () => {
    await env.DB.prepare("INSERT INTO users (email) VALUES ('schema-noref@test.dev')").run();
    const user = await env.DB.prepare("SELECT id FROM users WHERE email = 'schema-noref@test.dev'").first<{ id: number }>();
    await expect(
      env.DB.prepare(
        "INSERT INTO credit_ledger (user_id, kind, amount_mcr) VALUES (?1, 'capture', 0)"
      ).bind(user!.id).run()
    ).rejects.toThrow(/CHECK/);
  });
});
