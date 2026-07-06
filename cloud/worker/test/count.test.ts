import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { allocate, getBalanceMcr } from "../src/ledger";
import { createJob, getJobForUser } from "../src/jobs";
import { countJob, startJob } from "../src/start";
import { createUser } from "./helpers";

async function receivedJob(opts: { fundMcr?: number; mode?: "reflow" | "fixed" } = {}) {
  const userId = await createUser();
  if (opts.fundMcr) {
    await allocate(env.DB, { userId, amountMcr: opts.fundMcr, note: null, createdBy: "adnan@thothica.com" });
  }
  await env.STORE.put(`uploads/${userId}/j.pdf`, "%PDF-fake");
  const job = await createJob(env.DB, {
    userId, mode: opts.mode ?? "reflow", express: false, title: null,
    r2UploadKey: `uploads/${userId}/j.pdf`,
  });
  return { userId, job };
}

const tenPages = async (_pdf: ArrayBuffer) => ({ pageCount: 10 });
const explode = async (_pdf: ArrayBuffer): Promise<{ pageCount: number }> => {
  throw new Error("prepare should not have been called");
};

describe("countJob", () => {
  it("stores page count and rate, charges nothing", async () => {
    const { userId, job } = await receivedJob({ fundMcr: 50_000 });
    const res = await countJob(env.DB, env.STORE, tenPages, job.id, userId);
    expect(res).toEqual({ ok: true, pageCount: 10, rateMcr: 900, creditsMcr: 9_000 });
    expect(await getBalanceMcr(env.DB, userId)).toBe(50_000); // no hold placed
    const after = await getJobForUser(env.DB, job.id, userId);
    expect(after!.status).toBe("received"); // not started
    expect(after!.pageCount).toBe(10);
    expect(after!.rateMcr).toBe(900);
    expect(after!.holdId).toBeNull();
  });

  it("prices fixed layout at 3.0/page", async () => {
    const { userId, job } = await receivedJob({ mode: "fixed" });
    const res = await countJob(env.DB, env.STORE, tenPages, job.id, userId);
    expect(res).toEqual({ ok: true, pageCount: 10, rateMcr: 3_000, creditsMcr: 30_000 });
  });

  it("is idempotent: a second count re-reads the stored figures, no re-prepare", async () => {
    const { userId, job } = await receivedJob();
    await countJob(env.DB, env.STORE, tenPages, job.id, userId);
    const again = await countJob(env.DB, env.STORE, explode, job.id, userId);
    expect(again).toEqual({ ok: true, pageCount: 10, rateMcr: 900, creditsMcr: 9_000 });
  });

  it("fails the job cleanly on an unreadable file, no charge", async () => {
    const { userId, job } = await receivedJob({ fundMcr: 50_000 });
    const res = await countJob(env.DB, env.STORE, explode, job.id, userId);
    expect(res).toEqual({ ok: false, reason: "engine_error" });
    const after = await getJobForUser(env.DB, job.id, userId);
    expect(after!.status).toBe("failed");
    expect(after!.errorPublic).toBe("we could not read this file");
    expect(await getBalanceMcr(env.DB, userId)).toBe(50_000);
  });

  it("start reuses a stored page count without a second prepare", async () => {
    const { userId, job } = await receivedJob({ fundMcr: 50_000 });
    await countJob(env.DB, env.STORE, tenPages, job.id, userId);
    // explode() throws if called; start must use the stored count instead.
    const res = await startJob(env.DB, env.STORE, explode, job.id, userId);
    expect(res).toEqual({ ok: true, pageCount: 10, heldMcr: 9_000 });
    expect(await getBalanceMcr(env.DB, userId)).toBe(41_000); // one hold of 9000
    const after = await getJobForUser(env.DB, job.id, userId);
    expect(after!.status).toBe("processing");
  });
});
