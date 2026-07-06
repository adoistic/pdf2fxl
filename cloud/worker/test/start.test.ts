import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { allocate, getBalanceMcr } from "../src/ledger";
import { createJob, getJobForUser } from "../src/jobs";
import { startJob } from "../src/start";
import { createUser } from "./helpers";

async function seededJob(opts: { fundMcr: number; express?: boolean; mode?: "reflow" | "fixed" }) {
  const userId = await createUser();
  if (opts.fundMcr > 0) {
    await allocate(env.DB, { userId, amountMcr: opts.fundMcr, note: null, createdBy: "adnan@thothica.com" });
  }
  await env.STORE.put(`uploads/${userId}/j.pdf`, "%PDF-fake");
  const job = await createJob(env.DB, {
    userId, mode: opts.mode ?? "reflow", express: opts.express ?? true,
    title: null, r2UploadKey: `uploads/${userId}/j.pdf`,
  });
  return { userId, job };
}

const tenPages = async (_pdf: ArrayBuffer) => ({ pageCount: 10 });

describe("startJob", () => {
  it("prices express reflow at 0.9/page and holds exactly", async () => {
    const { userId, job } = await seededJob({ fundMcr: 20_000, express: true });
    const res = await startJob(env.DB, env.STORE, tenPages, job.id, userId);
    expect(res).toEqual({ ok: true, pageCount: 10, heldMcr: 9_000 });
    expect(await getBalanceMcr(env.DB, userId)).toBe(11_000);
    const after = await getJobForUser(env.DB, job.id, userId);
    expect(after!.status).toBe("processing");
    expect(after!.rateMcr).toBe(900);
    expect(after!.holdId).not.toBeNull();
  });

  it("prices batch reflow at 0.7/page", async () => {
    const { userId, job } = await seededJob({ fundMcr: 20_000, express: false });
    const res = await startJob(env.DB, env.STORE, tenPages, job.id, userId);
    expect(res).toEqual({ ok: true, pageCount: 10, heldMcr: 7_000 });
  });

  it("prices fixed layout at 3.0/page (express 3.2)", async () => {
    const a = await seededJob({ fundMcr: 40_000, mode: "fixed", express: false });
    expect(await startJob(env.DB, env.STORE, tenPages, a.job.id, a.userId)).toEqual({
      ok: true, pageCount: 10, heldMcr: 30_000,
    });
    const b = await seededJob({ fundMcr: 40_000, mode: "fixed", express: true });
    expect(await startJob(env.DB, env.STORE, tenPages, b.job.id, b.userId)).toEqual({
      ok: true, pageCount: 10, heldMcr: 32_000,
    });
  });

  it("fails the job cleanly when credits are insufficient", async () => {
    const { userId, job } = await seededJob({ fundMcr: 5_000, express: true }); // needs 9000
    const res = await startJob(env.DB, env.STORE, tenPages, job.id, userId);
    expect(res).toEqual({ ok: false, reason: "insufficient_credits" });
    const after = await getJobForUser(env.DB, job.id, userId);
    expect(after!.status).toBe("failed");
    expect(after!.errorPublic).toContain("credit");
    expect(await getBalanceMcr(env.DB, userId)).toBe(5_000); // nothing held
  });

  it("cannot start the same job twice", async () => {
    const { userId, job } = await seededJob({ fundMcr: 20_000 });
    expect((await startJob(env.DB, env.STORE, tenPages, job.id, userId)).ok).toBe(true);
    const again = await startJob(env.DB, env.STORE, tenPages, job.id, userId);
    expect(again).toEqual({ ok: false, reason: "not_startable" });
    expect(await getBalanceMcr(env.DB, userId)).toBe(11_000); // one hold only
  });

  it("fails cleanly when the engine errors, leaving no hold", async () => {
    const { userId, job } = await seededJob({ fundMcr: 20_000 });
    const broken = async () => { throw new Error("engine down"); };
    const res = await startJob(env.DB, env.STORE, broken, job.id, userId);
    expect(res).toEqual({ ok: false, reason: "engine_error" });
    const after = await getJobForUser(env.DB, job.id, userId);
    expect(after!.status).toBe("failed");
    expect(after!.errorPublic).not.toMatch(/engine|mistral|pdf2fxl/i);
    expect(await getBalanceMcr(env.DB, userId)).toBe(20_000);
  });

  it("two concurrent starts: exactly one wins, exactly one hold", async () => {
    const { userId, job } = await seededJob({ fundMcr: 50_000, express: true });
    const results = await Promise.all([
      startJob(env.DB, env.STORE, tenPages, job.id, userId),
      startJob(env.DB, env.STORE, tenPages, job.id, userId),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const { results: holds } = await env.DB.prepare(
      "SELECT id FROM credit_ledger WHERE job_id = ?1 AND kind = 'hold'"
    ).bind(job.id).all();
    expect(holds).toHaveLength(1);
  });

  it("missing pricing config fails the job cleanly, no 500, no stuck state", async () => {
    const { userId, job } = await seededJob({ fundMcr: 50_000, express: false });
    await env.DB.prepare("DELETE FROM config WHERE key = 'rate_reflow_mcr'").run();
    const res = await startJob(env.DB, env.STORE, tenPages, job.id, userId);
    expect(res).toEqual({ ok: false, reason: "engine_error" });
    const after = await getJobForUser(env.DB, job.id, userId);
    expect(after!.status).toBe("failed");
    expect(await getBalanceMcr(env.DB, userId)).toBe(50_000);
    await env.DB.prepare("INSERT INTO config (key, value) VALUES ('rate_reflow_mcr', '700')").run();
  });

  it("absurd page counts fail cleanly instead of overflowing the hold", async () => {
    const { userId, job } = await seededJob({ fundMcr: 50_000, express: false });
    const absurd = async () => ({ pageCount: 1e13 });
    const res = await startJob(env.DB, env.STORE, absurd, job.id, userId);
    expect(res).toEqual({ ok: false, reason: "engine_error" });
    const after = await getJobForUser(env.DB, job.id, userId);
    expect(after!.status).toBe("failed");
    expect(await getBalanceMcr(env.DB, userId)).toBe(50_000);
  });
});
