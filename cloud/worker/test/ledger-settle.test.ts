import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { allocate, captureHold, getBalanceMcr, getSettlement, placeHold, releaseHold } from "../src/ledger";
import { createUser } from "./helpers";

async function fundedHold(amountMcr: number, fundMcr = 100_000) {
  const userId = await createUser();
  await allocate(env.DB, { userId, amountMcr: fundMcr, note: null, createdBy: "adnan@thothica.com" });
  const hold = await placeHold(env.DB, { userId, jobId: "job-x", amountMcr });
  if (!hold.ok) throw new Error("test setup: hold failed");
  return { userId, holdId: hold.holdId };
}

describe("ledger: capture and release", () => {
  it("reports how a hold was settled", async () => {
    const a = await fundedHold(7_000);
    expect(await getSettlement(env.DB, a.holdId)).toBeNull();
    await captureHold(env.DB, a.holdId);
    expect((await getSettlement(env.DB, a.holdId))?.kind).toBe("capture");
    const b = await fundedHold(7_000);
    await releaseHold(env.DB, b.holdId);
    expect((await getSettlement(env.DB, b.holdId))?.kind).toBe("release");
    expect(await getSettlement(env.DB, 999_999)).toBeNull();
  });

  it("capture keeps the charge; balance stays reduced", async () => {
    const { userId, holdId } = await fundedHold(7_000);
    expect(await captureHold(env.DB, holdId)).toBe(true);
    expect(await getBalanceMcr(env.DB, userId)).toBe(93_000);
  });

  it("release refunds the hold in full", async () => {
    const { userId, holdId } = await fundedHold(7_000);
    expect(await releaseHold(env.DB, holdId)).toBe(true);
    expect(await getBalanceMcr(env.DB, userId)).toBe(100_000);
  });

  it("a hold settles exactly once: second capture is a no-op", async () => {
    const { holdId } = await fundedHold(7_000);
    expect(await captureHold(env.DB, holdId)).toBe(true);
    expect(await captureHold(env.DB, holdId)).toBe(false);
  });

  it("cannot release after capture (no refund of a delivered job)", async () => {
    const { userId, holdId } = await fundedHold(7_000);
    expect(await captureHold(env.DB, holdId)).toBe(true);
    expect(await releaseHold(env.DB, holdId)).toBe(false);
    expect(await getBalanceMcr(env.DB, userId)).toBe(93_000);
  });

  it("cannot capture after release (no charging a refunded job)", async () => {
    const { userId, holdId } = await fundedHold(7_000);
    expect(await releaseHold(env.DB, holdId)).toBe(true);
    expect(await captureHold(env.DB, holdId)).toBe(false);
    expect(await getBalanceMcr(env.DB, userId)).toBe(100_000);
  });

  it("concurrent capture and release: exactly one wins", async () => {
    const { userId, holdId } = await fundedHold(7_000);
    const [c, r] = await Promise.all([
      captureHold(env.DB, holdId),
      releaseHold(env.DB, holdId),
    ]);
    expect([c, r].filter(Boolean)).toHaveLength(1);
    const balance = await getBalanceMcr(env.DB, userId);
    expect([93_000, 100_000]).toContain(balance);
  });

  it("settling a nonexistent id or a non-hold row does nothing", async () => {
    const { userId, holdId } = await fundedHold(7_000);
    expect(await captureHold(env.DB, 999_999)).toBe(false);
    // a non-hold row: the allocation row for this user
    const alloc = await env.DB.prepare(
      "SELECT id FROM credit_ledger WHERE user_id = ?1 AND kind = 'allocation'"
    ).bind(userId).first<{ id: number }>();
    expect(await captureHold(env.DB, alloc!.id)).toBe(false);
    expect(await captureHold(env.DB, holdId)).toBe(true); // the real hold still settles
  });

  it("release refuses non-hold rows, including negative allocations (no minting)", async () => {
    const userId = await createUser();
    await allocate(env.DB, { userId, amountMcr: 50_000, note: null, createdBy: "adnan@thothica.com" });
    // a negative allocation (admin revoke) is the dangerous target: releasing it would mint credits
    await allocate(env.DB, { userId, amountMcr: -20_000, note: "revoke", createdBy: "adnan@thothica.com" });
    const revoke = await env.DB.prepare(
      "SELECT id FROM credit_ledger WHERE user_id = ?1 AND amount_mcr = -20000"
    ).bind(userId).first<{ id: number }>();
    expect(await releaseHold(env.DB, revoke!.id)).toBe(false);
    expect(await releaseHold(env.DB, 999_999)).toBe(false);
    expect(await getBalanceMcr(env.DB, userId)).toBe(30_000);
  });

  it("a released hold cannot be released twice", async () => {
    const { userId, holdId } = await fundedHold(7_000);
    expect(await releaseHold(env.DB, holdId)).toBe(true);
    expect(await releaseHold(env.DB, holdId)).toBe(false);
    expect(await getBalanceMcr(env.DB, userId)).toBe(100_000);
  });
});
