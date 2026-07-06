import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { allocate } from "../src/ledger";
import { createJob } from "../src/jobs";
import { startJob } from "../src/start";
import { finalizeJob, type ProcessFn } from "../src/finalize";
import { buildDownload, safeTitle, type RenderFn } from "../src/download";
import { createUser } from "./helpers";

const artifacts: Awaited<ReturnType<ProcessFn>> = {
  page_count: 10,
  verbatim: [{ page: 1 }],
  doc_json: { title: "My Book", language: "en", nodes: [{ level: 1, text: "One", _kind: "Heading" }] },
  markdown: "# My Book\n\nBody.",
  figures: [{ name: "img-0.png", base64: btoa("PNG") }],
};

// A ready job with artifacts stored, via the real finalize path.
async function readyJob(title = "My Book") {
  const userId = await createUser();
  await allocate(env.DB, { userId, amountMcr: 20_000, note: null, createdBy: "adnan@thothica.com" });
  const key = `uploads/${userId}/j.pdf`;
  await env.STORE.put(key, "%PDF-fake");
  const job = await createJob(env.DB, { userId, mode: "reflow", express: false, title, r2UploadKey: key });
  await startJob(env.DB, env.STORE, async () => ({ pageCount: 10 }), job.id, userId);
  await finalizeJob(env, job.id, async (pdf) => {
    if (pdf instanceof ReadableStream) await new Response(pdf).arrayBuffer();
    return artifacts;
  });
  return { userId, jobId: job.id };
}

const stubRender: RenderFn = async (_doc, _figs, format) =>
  new TextEncoder().encode(format === "epub" ? "PK-epub-bytes" : "PK-docx-bytes");

describe("buildDownload", () => {
  it("streams stored markdown with a safe filename", async () => {
    const { userId, jobId } = await readyJob("A Nice Book!");
    const r = await buildDownload(env, jobId, userId, "md", stubRender);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.contentType).toContain("text/markdown");
      expect(r.filename).toBe("A-Nice-Book.md");
      expect(r.body).toContain("# My Book");
    }
  });

  it("renders epub via the container and names it from the title", async () => {
    const { userId, jobId } = await readyJob();
    const r = await buildDownload(env, jobId, userId, "epub", stubRender);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.contentType).toBe("application/epub+zip");
      expect(r.filename).toBe("My-Book.epub");
      expect(new TextDecoder().decode(r.body as Uint8Array)).toBe("PK-epub-bytes");
    }
  });

  it("renders docx", async () => {
    const { userId, jobId } = await readyJob();
    const r = await buildDownload(env, jobId, userId, "docx", stubRender);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.filename).toBe("My-Book.docx");
  });

  it("409s a job that is not ready", async () => {
    const userId = await createUser();
    await allocate(env.DB, { userId, amountMcr: 20_000, note: null, createdBy: "a@b.dev" });
    const job = await createJob(env.DB, { userId, mode: "reflow", express: false, title: "x", r2UploadKey: "k" });
    const r = await buildDownload(env, job.id, userId, "md", stubRender);
    expect(r).toEqual({ ok: false, status: 409, error: "this document is not ready yet" });
  });

  it("404s another user's job (no existence leak)", async () => {
    const { jobId } = await readyJob();
    const stranger = await createUser();
    const r = await buildDownload(env, jobId, stranger, "epub", stubRender);
    expect(r).toEqual({ ok: false, status: 404, error: "not found" });
  });

  it("400s an unknown format", async () => {
    const { userId, jobId } = await readyJob();
    const r = await buildDownload(env, jobId, userId, "pdf", stubRender);
    expect(r).toEqual({ ok: false, status: 400, error: "unknown format" });
  });

  it("safeTitle strips unsafe chars and falls back", async () => {
    expect(safeTitle("Hello / World")).toBe("Hello-World");
    expect(safeTitle(null)).toBe("thothica-edition");
    expect(safeTitle("  ")).toBe("thothica-edition");
  });
});
