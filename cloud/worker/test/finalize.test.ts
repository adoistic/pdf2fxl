import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { allocate, getBalanceMcr } from "../src/ledger";
import { createJob, getJobForUser } from "../src/jobs";
import { startJob } from "../src/start";
import { finalizeJob, type ProcessFn } from "../src/finalize";
import { createUser } from "./helpers";

// A processing job with a hold placed, mirroring start.test.ts. Reflow at
// 0.7/page x 10 pages = 7_000 mcr held.
async function processingJob(fundMcr = 20_000) {
  const userId = await createUser();
  await allocate(env.DB, { userId, amountMcr: fundMcr, note: null, createdBy: "adnan@thothica.com" });
  const key = `uploads/${userId}/j.pdf`;
  await env.STORE.put(key, "%PDF-fake");
  const job = await createJob(env.DB, {
    userId, mode: "reflow", express: true, title: "My Book", r2UploadKey: key,
  });
  const tenPages = async (_pdf: ArrayBuffer) => ({ pageCount: 10 });
  const res = await startJob(env.DB, env.STORE, tenPages, job.id, userId);
  expect(res.ok).toBe(true);
  return { userId, jobId: job.id, uploadKey: key };
}

const artifacts: Awaited<ReturnType<ProcessFn>> = {
  page_count: 10,
  verbatim: [{ page: 1, markdown: "# Title" }],
  doc_json: { blocks: [{ level: 1, text: "Title" }] },
  markdown: "# Title\n\nBody text.",
  figures: [{ name: "fig-1.png", base64: btoa("PNGDATA") }],
};

// Drain the streamed PDF like the real container fetch does, so the R2 object
// body is consumed and the pool's isolated storage teardown stays happy. Under
// r2Direct (true in tests) finalizeJob passes a url instead of the body, so the
// stream branch is inert here; the R2 object is not read as a stream.
const stubProcess: ProcessFn = async (input) => {
  if (input.kind === "stream" && input.body instanceof ReadableStream) {
    await new Response(input.body).arrayBuffer();
  }
  return artifacts;
};

describe("finalizeJob", () => {
  it("happy path: stores artifacts, captures the hold, marks ready, keeps the upload", async () => {
    const { userId, jobId, uploadKey } = await processingJob();
    expect(await getBalanceMcr(env.DB, userId)).toBe(13_000); // 20k - 7k hold

    const outcome = await finalizeJob(env, jobId, stubProcess);
    expect(outcome).toBe("ready");

    // Consume every body: undisposed R2 streams break the pool's isolated
    // storage teardown.
    expect(await (await env.STORE.get(`ocr/${jobId}/verbatim.json`))!.text()).toContain("markdown");
    expect(await (await env.STORE.get(`doc/${jobId}/normalized.json`))!.text()).toContain("blocks");
    expect(await (await env.STORE.get(`doc/${jobId}/normalized.md`))!.text()).toBe("# Title\n\nBody text.");
    expect(await (await env.STORE.get(`doc/${jobId}/figures/fig-1.png`))!.text()).toBe("PNGDATA");

    const job = await getJobForUser(env.DB, jobId, userId);
    expect(job!.status).toBe("ready");

    const row = await env.DB.prepare(
      "SELECT r2_verbatim_key, r2_doc_key, r2_md_key, r2_figures_prefix, finished_at FROM jobs WHERE id = ?1"
    ).bind(jobId).first<Record<string, string | null>>();
    expect(row!.r2_verbatim_key).toBe(`ocr/${jobId}/verbatim.json`);
    expect(row!.r2_doc_key).toBe(`doc/${jobId}/normalized.json`);
    expect(row!.r2_md_key).toBe(`doc/${jobId}/normalized.md`);
    expect(row!.r2_figures_prefix).toBe(`doc/${jobId}/figures/`);
    expect(row!.finished_at).not.toBeNull();

    // Hold captured: the negative hold stands as the final charge, balance stays.
    expect(await getBalanceMcr(env.DB, userId)).toBe(13_000);
    // Original kept for ~72h after the result (R2 lifecycle expires it), so a bad
    // render can be reprocessed.
    expect(await (await env.STORE.get(uploadKey))!.text()).toBe("%PDF-fake");
  });

  it("process throws: fails the job, releases the hold, keeps the upload", async () => {
    const { userId, jobId, uploadKey } = await processingJob();
    const boom: ProcessFn = async (input) => {
      if (input.kind === "stream" && input.body instanceof ReadableStream) {
        await input.body.cancel();
      }
      throw new Error("container 500");
    };

    const outcome = await finalizeJob(env, jobId, boom);
    expect(outcome).toBe("failed");

    const job = await getJobForUser(env.DB, jobId, userId);
    expect(job!.status).toBe("failed");
    expect(job!.errorPublic).not.toMatch(/container|mistral|pdf2fxl/i);
    // Hold released: balance back to the pre-hold 20_000.
    expect(await getBalanceMcr(env.DB, userId)).toBe(20_000);
    // Upload kept for a retry; no artifacts written.
    expect(await (await env.STORE.get(uploadKey))!.text()).toBe("%PDF-fake");
    expect(await env.STORE.get(`doc/${jobId}/normalized.md`)).toBeNull();
  });

  it("idempotent: a second finalize on a ready job is a no-op skip", async () => {
    const { userId, jobId } = await processingJob();
    expect(await finalizeJob(env, jobId, stubProcess)).toBe("ready");
    const balanceAfterFirst = await getBalanceMcr(env.DB, userId);

    let called = false;
    const guard: ProcessFn = async () => { called = true; return artifacts; };
    expect(await finalizeJob(env, jobId, guard)).toBe("skipped");
    expect(called).toBe(false); // never re-processed
    expect(await getBalanceMcr(env.DB, userId)).toBe(balanceAfterFirst); // no double capture
    const job = await getJobForUser(env.DB, jobId, userId);
    expect(job!.status).toBe("ready");
  });

  it("skips an unknown job id", async () => {
    expect(await finalizeJob(env, "no-such-job", stubProcess)).toBe("skipped");
  });

  it("r2Direct: passes a presigned GET url instead of the body", async () => {
    // The test env sets dummy R2 creds, so r2DirectEnabled() is true here.
    const { jobId } = await processingJob();
    let seen: string | undefined;
    const capture: ProcessFn = async (input) => {
      seen = input.kind === "url" ? input.inputUrl : "STREAM";
      return artifacts;
    };
    expect(await finalizeJob(env, jobId, capture)).toBe("ready");
    expect(seen).toContain("r2.cloudflarestorage.com");
    expect(seen).toContain("X-Amz-Signature");
  });
});
