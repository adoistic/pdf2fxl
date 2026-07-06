import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { allocate, getBalanceMcr } from "../src/ledger";
import { createUser } from "./helpers";

describe("ledger: balance and allocation", () => {
  it("new user has zero balance (no trial credits)", async () => {
    const userId = await createUser();
    expect(await getBalanceMcr(env.DB, userId)).toBe(0);
  });

  it("allocation adds to balance and records who and why", async () => {
    const userId = await createUser();
    await allocate(env.DB, {
      userId,
      amountMcr: 100_000,
      note: "client commitment",
      createdBy: "adnan@thothica.com",
    });
    expect(await getBalanceMcr(env.DB, userId)).toBe(100_000);
    const row = await env.DB.prepare(
      "SELECT kind, amount_mcr, note, created_by FROM credit_ledger WHERE user_id = ?1"
    ).bind(userId).first<{ kind: string; amount_mcr: number; note: string; created_by: string }>();
    expect(row).toEqual({
      kind: "allocation",
      amount_mcr: 100_000,
      note: "client commitment",
      created_by: "adnan@thothica.com",
    });
  });

  it("negative allocation (revoke) reduces balance", async () => {
    const userId = await createUser();
    await allocate(env.DB, { userId, amountMcr: 50_000, note: null, createdBy: "adnan@thothica.com" });
    await allocate(env.DB, { userId, amountMcr: -20_000, note: "correction", createdBy: "adnan@thothica.com" });
    expect(await getBalanceMcr(env.DB, userId)).toBe(30_000);
  });

  it("allocate rejects zero and non-integer amounts", async () => {
    const userId = await createUser();
    await expect(
      allocate(env.DB, { userId, amountMcr: 0, note: null, createdBy: "x" })
    ).rejects.toThrow();
    await expect(
      allocate(env.DB, { userId, amountMcr: 0.5, note: null, createdBy: "x" })
    ).rejects.toThrow();
  });
});
