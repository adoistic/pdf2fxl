import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createJob, getJobForUser, listJobsForUser, transition, failJob } from "../src/jobs";
import { allocate, placeHold } from "../src/ledger";
import { createUser } from "./helpers";

describe("jobs module", () => {
  it("creates and fetches a job scoped to its owner", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const job = await createJob(env.DB, {
      userId: owner, mode: "reflow", express: false, title: "My book",
      r2UploadKey: "uploads/u/j.pdf",
    });
    expect(job.status).toBe("received");
    expect((await getJobForUser(env.DB, job.id, owner))?.id).toBe(job.id);
    expect(await getJobForUser(env.DB, job.id, stranger)).toBeNull();
    expect((await listJobsForUser(env.DB, owner)).jobs.map((j) => j.id)).toEqual([job.id]);
  });

  it("transitions only from the expected state", async () => {
    const owner = await createUser();
    const job = await createJob(env.DB, {
      userId: owner, mode: "reflow", express: true, title: null, r2UploadKey: "k",
    });
    expect(await transition(env.DB, job.id, "received", "preparing")).toBe(true);
    expect(await transition(env.DB, job.id, "received", "preparing")).toBe(false); // stale
    await allocate(env.DB, { userId: owner, amountMcr: 10_000, note: null, createdBy: "test" });
    const hold = await placeHold(env.DB, { userId: owner, jobId: job.id, amountMcr: 900 });
    expect(hold.ok).toBe(true);
    const holdId = (hold as { ok: true; holdId: number }).holdId;
    expect(
      await transition(env.DB, job.id, "preparing", "processing", { page_count: 12, rate_mcr: 900, hold_id: holdId })
    ).toBe(true);
    const row = await getJobForUser(env.DB, job.id, owner);
    expect(row!.status).toBe("processing");
    expect(row!.pageCount).toBe(12);
  });

  it("failJob records a public reason and only from the given state", async () => {
    const owner = await createUser();
    const job = await createJob(env.DB, {
      userId: owner, mode: "fixed", express: false, title: null, r2UploadKey: "k",
    });
    expect(await failJob(env.DB, job.id, "received", "not enough credits", "hold refused")).toBe(true);
    const row = await getJobForUser(env.DB, job.id, owner);
    expect(row!.status).toBe("failed");
    expect(row!.errorPublic).toBe("not enough credits");
    expect(await failJob(env.DB, job.id, "received", "again", "x")).toBe(false);
  });

  it("honors an explicit id when provided", async () => {
    const owner = await createUser();
    const job = await createJob(env.DB, {
      id: "explicit-1", userId: owner, mode: "reflow", express: false, title: null, r2UploadKey: "k",
    });
    expect(job.id).toBe("explicit-1");
  });
});

describe("jobs module: bulk grouping", () => {
  it("groups jobs under a shared bulk id", async () => {
    const owner = await createUser();
    const bulkId = "bulk-abc";
    const a = await createJob(env.DB, { userId: owner, bulkId, mode: "reflow", express: false, title: "A", r2UploadKey: "k1" });
    const b = await createJob(env.DB, { userId: owner, bulkId, mode: "reflow", express: false, title: "B", r2UploadKey: "k2" });
    const solo = await createJob(env.DB, { userId: owner, mode: "reflow", express: false, title: "C", r2UploadKey: "k3" });
    expect(a.bulkId).toBe(bulkId);
    expect(b.bulkId).toBe(bulkId);
    expect(solo.bulkId).toBeNull();
    const all = (await listJobsForUser(env.DB, owner)).jobs;
    const inBulk = all.filter((j) => j.bulkId === bulkId).map((j) => j.title).sort();
    expect(inBulk).toEqual(["A", "B"]);
  });
});
