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
  await finalizeJob(env, job.id, async (input) => {
    if (input.kind === "stream" && input.body instanceof ReadableStream) {
      await new Response(input.body).arrayBuffer();
    }
    return artifacts;
  });
  return { userId, jobId: job.id };
}

const stubRender: RenderFn = async (_doc, _figs, format) =>
  new TextEncoder().encode(format === "epub" ? "PK-epub-bytes" : "PK-docx-bytes");

describe("buildDownload", () => {
  it("r2Direct: markdown download redirects to a presigned R2 url", async () => {
    // The test env sets dummy R2 creds, so r2DirectEnabled() is true.
    const { userId, jobId } = await readyJob("A Nice Book!");
    const r = await buildDownload(env, jobId, userId, "md", stubRender);
    expect(r.ok).toBe(true);
    if (r.ok && "redirect" in r) {
      expect(r.redirect).toContain("r2.cloudflarestorage.com");
      expect(r.redirect).toContain("X-Amz-Signature");
      // The stored md key, url-encoded (the slashes stay), points at R2.
      expect(r.redirect).toContain("normalized.md");
    } else {
      throw new Error("expected a redirect result under r2Direct");
    }
  });

  it("r2Direct: doc.json download redirects to a presigned R2 url", async () => {
    const { userId, jobId } = await readyJob();
    const r = await buildDownload(env, jobId, userId, "doc", stubRender);
    expect(r.ok).toBe(true);
    if (r.ok && "redirect" in r) {
      expect(r.redirect).toContain("r2.cloudflarestorage.com");
      expect(r.redirect).toContain("X-Amz-Signature");
      expect(r.redirect).toContain("normalized.json");
    } else {
      throw new Error("expected a redirect result under r2Direct");
    }
  });

  it("renders epub via the container and names it from the title", async () => {
    const { userId, jobId } = await readyJob();
    const r = await buildDownload(env, jobId, userId, "epub", stubRender);
    expect(r.ok).toBe(true);
    if (r.ok && !("redirect" in r)) {
      expect(r.contentType).toBe("application/epub+zip");
      expect(r.filename).toBe("My-Book.epub");
      expect(new TextDecoder().decode(r.body as Uint8Array)).toBe("PK-epub-bytes");
    } else {
      throw new Error("epub should render bytes, not redirect");
    }
  });

  it("renders docx", async () => {
    const { userId, jobId } = await readyJob();
    const r = await buildDownload(env, jobId, userId, "docx", stubRender);
    expect(r.ok).toBe(true);
    if (r.ok && !("redirect" in r)) expect(r.filename).toBe("My-Book.docx");
    else throw new Error("docx should render bytes, not redirect");
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
