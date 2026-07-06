import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { allocate, getBalanceMcr, placeHold } from "../src/ledger";
import { createUser } from "./helpers";

async function fund(userId: number, amountMcr: number) {
  await allocate(env.DB, { userId, amountMcr, note: null, createdBy: "adnan@thothica.com" });
}

describe("ledger: holds", () => {
  it("places a hold when balance is sufficient and reduces available balance", async () => {
    const userId = await createUser();
    await fund(userId, 10_000); // 10 credits
    const res = await placeHold(env.DB, { userId, jobId: "job-1", amountMcr: 7_000 });
    expect(res.ok).toBe(true);
    expect(await getBalanceMcr(env.DB, userId)).toBe(3_000);
  });

  it("refuses a hold beyond the available balance, atomically", async () => {
    const userId = await createUser();
    await fund(userId, 5_000);
    const res = await placeHold(env.DB, { userId, jobId: "job-2", amountMcr: 7_000 });
    expect(res).toEqual({ ok: false, reason: "insufficient_credits" });
    expect(await getBalanceMcr(env.DB, userId)).toBe(5_000);
  });

  it("counts existing holds against the balance for new holds", async () => {
    const userId = await createUser();
    await fund(userId, 10_000);
    const first = await placeHold(env.DB, { userId, jobId: "job-3a", amountMcr: 7_000 });
    expect(first.ok).toBe(true);
    const second = await placeHold(env.DB, { userId, jobId: "job-3b", amountMcr: 7_000 });
    expect(second).toEqual({ ok: false, reason: "insufficient_credits" });
  });

  it("rejects non-positive hold amounts", async () => {
    const userId = await createUser();
    await fund(userId, 10_000);
    await expect(placeHold(env.DB, { userId, jobId: "job-4", amountMcr: 0 })).rejects.toThrow();
    await expect(placeHold(env.DB, { userId, jobId: "job-4", amountMcr: -5 })).rejects.toThrow();
  });

  it("allows a hold equal to the full balance, then nothing more", async () => {
    const userId = await createUser();
    await fund(userId, 10_000);
    const res = await placeHold(env.DB, { userId, jobId: "job-5", amountMcr: 10_000 });
    expect(res.ok).toBe(true);
    expect(await getBalanceMcr(env.DB, userId)).toBe(0);
    const more = await placeHold(env.DB, { userId, jobId: "job-5b", amountMcr: 1 });
    expect(more).toEqual({ ok: false, reason: "insufficient_credits" });
  });
});
