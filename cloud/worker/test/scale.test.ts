import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, it, expect } from "vitest";
import { app } from "../src/index";
import { allocate, getBalanceMcr, placeHold, getSettlement } from "../src/ledger";
import { createJob, listJobsForUser, transition } from "../src/jobs";
import { startJob } from "../src/start";
import { cleanupUpload, sweep } from "../src/sweep";
import { createUser } from "./helpers";
import { makeFirebaseMock, type FirebaseMock } from "./firebase-mock";

let fb: FirebaseMock;
let token: string;

beforeAll(async () => {
  fb = await makeFirebaseMock("test-project");
  fetchMock.activate();
  fetchMock.disableNetConnect();
  fetchMock
    .get("https://www.googleapis.com")
    .intercept({ path: "/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com" })
    .reply(200, JSON.stringify(fb.jwks), {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
    })
    .persist();
  token = await fb.tokenFor({ sub: "uid-scale", email: "scale@test.dev" });
});

async function makeJobs(userId: number, titles: string[]) {
  const jobs = [];
  for (let i = 0; i < titles.length; i++) {
    const job = await createJob(env.DB, {
      userId, mode: "reflow", express: false, title: titles[i],
      r2UploadKey: `uploads/${userId}/${i}.pdf`,
    });
    // Deterministic ordering: older indexes are older jobs.
    await env.DB
      .prepare(`UPDATE jobs SET created_at = datetime('now', ?1) WHERE id = ?2`)
      .bind(`-${titles.length - i} minutes`, job.id)
      .run();
    jobs.push(job);
  }
  return jobs;
}

// ------------------------------------------------------------- pagination --
describe("paged, searchable jobs list", () => {
  it("pages newest first with a total", async () => {
    const userId = await createUser();
    await makeJobs(userId, ["Alpha", "Bravo", "Charlie", "Delta", "Echo"]);
    const page1 = await listJobsForUser(env.DB, userId, { limit: 2 });
    expect(page1.total).toBe(5);
    expect(page1.jobs.map((j) => j.title)).toEqual(["Echo", "Delta"]);
    const page2 = await listJobsForUser(env.DB, userId, { limit: 2, offset: 2 });
    expect(page2.jobs.map((j) => j.title)).toEqual(["Charlie", "Bravo"]);
  });

  it("searches titles, with LIKE wildcards escaped", async () => {
    const userId = await createUser();
    await makeJobs(userId, ["Mughal Gardens", "Sale 50% off", "Sale 500 off"]);
    const hit = await listJobsForUser(env.DB, userId, { q: "gard" });
    expect(hit.total).toBe(1);
    expect(hit.jobs[0].title).toBe("Mughal Gardens");
    const literal = await listJobsForUser(env.DB, userId, { q: "50%" });
    expect(literal.total).toBe(1);
    expect(literal.jobs[0].title).toBe("Sale 50% off");
    const none = await listJobsForUser(env.DB, userId, { q: "zzz" });
    expect(none.total).toBe(0);
  });

  it("the route passes limit, offset, and q through and returns the total", async () => {
    const me = await app.request(
      "/api/me", { headers: { Authorization: `Bearer ${token}` } }, env
    );
    expect(me.status).toBe(200);
    const row = await env.DB
      .prepare("SELECT id FROM users WHERE email = 'scale@test.dev'")
      .first<{ id: number }>();
    await makeJobs(row!.id, ["One", "Two", "Three"]);
    const res = await app.request(
      "/api/jobs?limit=1&offset=1&q=t",
      { headers: { Authorization: `Bearer ${token}` } },
      env
    );
    const body = (await res.json()) as { jobs: { title: string }[]; total: number };
    expect(body.total).toBe(2); // Two, Three
    expect(body.jobs.length).toBe(1);
    expect(body.jobs[0].title).toBe("Two");
  });
});

// ------------------------------------------------------- two-tab credit race --
describe("credits cannot be spent twice across tabs", () => {
  it("two concurrent holds against one balance: exactly one wins", async () => {
    // 50 credits; two ~40-credit holds land at the same time from two tabs.
    const userId = await createUser();
    await allocate(env.DB, { userId, amountMcr: 50_000, note: null, createdBy: "t" });
    const [a, b] = await Promise.all([
      placeHold(env.DB, { userId, jobId: "tab-a", amountMcr: 40_000 }),
      placeHold(env.DB, { userId, jobId: "tab-b", amountMcr: 40_000 }),
    ]);
    expect([a.ok, b.ok].filter(Boolean).length).toBe(1);
    expect(await getBalanceMcr(env.DB, userId)).toBe(10_000);
  });

  it("two concurrent startJob calls: one processes, one is refused unpaid", async () => {
    const userId = await createUser();
    await allocate(env.DB, { userId, amountMcr: 30_000, note: null, createdBy: "t" });
    const prepare = async () => ({ pageCount: 40 }); // 40 x 700 = 28_000 mcr
    const jobs = await makeJobs(userId, ["Tab one", "Tab two"]);
    await env.STORE.put(jobs[0].r2UploadKey!, "%PDF-a");
    await env.STORE.put(jobs[1].r2UploadKey!, "%PDF-b");
    const [a, b] = await Promise.all([
      startJob(env.DB, env.STORE, prepare, jobs[0].id, userId),
      startJob(env.DB, env.STORE, prepare, jobs[1].id, userId),
    ]);
    const oks = [a, b].filter((r) => r.ok);
    expect(oks.length).toBe(1);
    const refused = [a, b].find((r) => !r.ok)!;
    expect(refused).toEqual({ ok: false, reason: "insufficient_credits" });
    // Only one hold stands; the refused job took nothing.
    expect(await getBalanceMcr(env.DB, userId)).toBe(30_000 - 28_000);
  });

  it("the same job started from two tabs cannot double-charge", async () => {
    const userId = await createUser();
    await allocate(env.DB, { userId, amountMcr: 100_000, note: null, createdBy: "t" });
    const prepare = async () => ({ pageCount: 10 });
    const [job] = await makeJobs(userId, ["Same book"]);
    await env.STORE.put(job.r2UploadKey!, "%PDF-x");
    const [a, b] = await Promise.all([
      startJob(env.DB, env.STORE, prepare, job.id, userId),
      startJob(env.DB, env.STORE, prepare, job.id, userId),
    ]);
    const oks = [a, b].filter((r) => r.ok);
    expect(oks.length).toBe(1);
    expect([a, b].find((r) => !r.ok)).toEqual({ ok: false, reason: "not_startable" });
    const holds = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM credit_ledger WHERE job_id = ?1 AND kind = 'hold'")
      .bind(job.id)
      .first<{ n: number }>();
    expect(holds!.n).toBe(1);
    expect(await getBalanceMcr(env.DB, userId)).toBe(100_000 - 7_000);
  });
});

// ------------------------------------------------------------ upload cleanup --
async function readyJobWithUpload(userId: number, finishedAgo: string) {
  const [job] = await makeJobs(userId, ["Done book"]);
  await env.STORE.put(job.r2UploadKey!, "%PDF-done");
  await env.DB
    .prepare(
      `UPDATE jobs SET status = 'ready', finished_at = datetime('now', ?1) WHERE id = ?2`
    )
    .bind(finishedAgo, job.id)
    .run();
  return job;
}

describe("original PDFs are deleted once the edition is delivered", () => {
  it("cleanupUpload deletes the original of a ready job and nulls the key", async () => {
    const userId = await createUser();
    const job = await readyJobWithUpload(userId, "-1 minutes");
    expect(await cleanupUpload(env, job.id)).toBe(true);
    expect(await env.STORE.head(job.r2UploadKey!)).toBeNull();
    const row = await env.DB
      .prepare("SELECT r2_upload_key FROM jobs WHERE id = ?1")
      .bind(job.id)
      .first<{ r2_upload_key: string | null }>();
    expect(row!.r2_upload_key).toBeNull();
  });

  it("cleanupUpload leaves non-ready jobs alone (72h backstop applies)", async () => {
    const userId = await createUser();
    const [job] = await makeJobs(userId, ["Waiting book"]);
    await env.STORE.put(job.r2UploadKey!, "%PDF-wait");
    expect(await cleanupUpload(env, job.id)).toBe(false);
    expect(await env.STORE.head(job.r2UploadKey!)).not.toBeNull();
  });

  it("the sweep deletes originals the precise path missed, after 10 minutes", async () => {
    const userId = await createUser();
    const stale = await readyJobWithUpload(userId, "-11 minutes");
    const report = await sweep(env);
    expect(report.uploadsDeleted).toBeGreaterThanOrEqual(1);
    expect(await env.STORE.head(stale.r2UploadKey!)).toBeNull();
  });

  it("the sweep keeps originals inside the 10 minute buffer", async () => {
    const userId = await createUser();
    const fresh = await readyJobWithUpload(userId, "-2 minutes");
    await sweep(env);
    expect(await env.STORE.head(fresh.r2UploadKey!)).not.toBeNull();
  });
});

// ------------------------------------------------------------------- sweep --
describe("hourly sweep settles what crashes left behind", () => {
  it("fails a job stuck in preparing and releases its hold", async () => {
    const userId = await createUser();
    await allocate(env.DB, { userId, amountMcr: 20_000, note: null, createdBy: "t" });
    const [job] = await makeJobs(userId, ["Stuck book"]);
    const hold = await placeHold(env.DB, { userId, jobId: job.id, amountMcr: 7_000 });
    if (!hold.ok) throw new Error("hold failed in fixture");
    await env.DB
      .prepare(
        `UPDATE jobs SET status = 'preparing', hold_id = ?1,
           updated_at = datetime('now','-2 hours') WHERE id = ?2`
      )
      .bind(hold.holdId, job.id)
      .run();
    const report = await sweep(env);
    expect(report.stuckJobs).toBeGreaterThanOrEqual(1);
    const row = await env.DB
      .prepare("SELECT status FROM jobs WHERE id = ?1")
      .bind(job.id)
      .first<{ status: string }>();
    expect(row!.status).toBe("failed");
    expect(await getBalanceMcr(env.DB, userId)).toBe(20_000); // refunded in full
  });

  it("leaves live processing jobs alone", async () => {
    const userId = await createUser();
    await allocate(env.DB, { userId, amountMcr: 20_000, note: null, createdBy: "t" });
    const [job] = await makeJobs(userId, ["Live book"]);
    const hold = await placeHold(env.DB, { userId, jobId: job.id, amountMcr: 7_000 });
    if (!hold.ok) throw new Error("hold failed in fixture");
    await env.DB
      .prepare("UPDATE jobs SET status = 'processing', hold_id = ?1, updated_at = datetime('now') WHERE id = ?2")
      .bind(hold.holdId, job.id)
      .run();
    await sweep(env);
    const row = await env.DB
      .prepare("SELECT status FROM jobs WHERE id = ?1")
      .bind(job.id)
      .first<{ status: string }>();
    expect(row!.status).toBe("processing");
    expect(await getBalanceMcr(env.DB, userId)).toBe(13_000); // hold still stands
  });

  it("captures the hold of a delivered job that crashed before capture", async () => {
    const userId = await createUser();
    await allocate(env.DB, { userId, amountMcr: 20_000, note: null, createdBy: "t" });
    const [job] = await makeJobs(userId, ["Delivered book"]);
    const hold = await placeHold(env.DB, { userId, jobId: job.id, amountMcr: 7_000 });
    if (!hold.ok) throw new Error("hold failed in fixture");
    await env.DB
      .prepare("UPDATE jobs SET status = 'ready', hold_id = ?1 WHERE id = ?2")
      .bind(hold.holdId, job.id)
      .run();
    const report = await sweep(env);
    expect(report.capturedHolds).toBeGreaterThanOrEqual(1);
    expect(await getSettlement(env.DB, hold.holdId)).toEqual(
      expect.objectContaining({ kind: "capture" })
    );
    expect(await getBalanceMcr(env.DB, userId)).toBe(13_000); // charge stands
  });

  it("releases an orphan hold no live row references", async () => {
    const userId = await createUser();
    await allocate(env.DB, { userId, amountMcr: 20_000, note: null, createdBy: "t" });
    // A crash between placeHold and the transition that records hold_id.
    const hold = await placeHold(env.DB, { userId, jobId: "gone-job", amountMcr: 9_000 });
    if (!hold.ok) throw new Error("hold failed in fixture");
    await env.DB
      .prepare("UPDATE credit_ledger SET created_at = datetime('now','-3 hours') WHERE id = ?1")
      .bind(hold.holdId)
      .run();
    const report = await sweep(env);
    expect(report.releasedHolds).toBeGreaterThanOrEqual(1);
    expect(await getBalanceMcr(env.DB, userId)).toBe(20_000);
  });

  it("does not release a fresh unsettled hold (live traffic)", async () => {
    const userId = await createUser();
    await allocate(env.DB, { userId, amountMcr: 20_000, note: null, createdBy: "t" });
    const hold = await placeHold(env.DB, { userId, jobId: "in-flight", amountMcr: 9_000 });
    if (!hold.ok) throw new Error("hold failed in fixture");
    await sweep(env);
    expect(await getSettlement(env.DB, hold.holdId)).toBeNull();
    expect(await getBalanceMcr(env.DB, userId)).toBe(11_000);
  });
});
