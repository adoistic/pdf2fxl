import { Hono } from "hono";
import type { AppUser, Env } from "../types";
import { createJob, getJobForUser, listJobsForUser, type Job, type JobMode } from "../jobs";
import { startJob } from "../start";

// Deliverable ceiling: the body is buffered in the isolate (128MB memory) and
// the edge caps request bodies near this size anyway. Larger scans need the
// streaming upload planned for 2b, not a bigger constant.
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export const jobs = new Hono<{ Bindings: Env; Variables: { user: AppUser } }>();

function publicJob(j: Job) {
  return {
    id: j.id, mode: j.mode, express: j.express, status: j.status, title: j.title,
    pageCount: j.pageCount, error: j.errorPublic, createdAt: j.createdAt,
  };
}

jobs.post("/", async (c) => {
  const user = c.get("user");
  const mode = c.req.query("mode");
  const express = c.req.query("express") === "1";
  const title = c.req.query("title")?.slice(0, 200) || null;
  if (mode !== "reflow" && mode !== "fixed") {
    return c.json({ error: "mode must be reflow or fixed" }, 400);
  }
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > MAX_UPLOAD_BYTES) {
    return c.json({ error: "file is too large" }, 413);
  }
  const body = c.req.raw.body;
  if (!body) {
    return c.json({ error: "attach a PDF as the request body" }, 400);
  }
  // Buffer to check the magic bytes; R2 needs a known length anyway.
  const bytes = new Uint8Array(await c.req.raw.arrayBuffer());
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return c.json({ error: "file is too large" }, 413);
  }
  const head = new TextDecoder().decode(bytes.slice(0, 5));
  if (head !== "%PDF-") {
    return c.json({ error: "that does not look like a PDF" }, 400);
  }
  const id = crypto.randomUUID();
  const key = `uploads/${user.id}/${id}.pdf`;
  await c.env.STORE.put(key, bytes, { httpMetadata: { contentType: "application/pdf" } });
  const job = await createJob(c.env.DB, {
    id, userId: user.id, mode: mode as JobMode, express, title, r2UploadKey: key,
  });
  return c.json(publicJob(job));
});

jobs.get("/", async (c) => {
  const list = await listJobsForUser(c.env.DB, c.get("user").id);
  return c.json({ jobs: list.map(publicJob) });
});

jobs.get("/:id", async (c) => {
  const job = await getJobForUser(c.env.DB, c.req.param("id"), c.get("user").id);
  if (!job) return c.json({ error: "not found" }, 404);
  return c.json(publicJob(job));
});

jobs.post("/:id/start", async (c) => {
  const user = c.get("user");
  const prepare = async (pdf: ArrayBuffer) => {
    const engine = c.env.OCR_ENGINE.getByName("engine");
    const res = await engine.fetch(
      new Request("http://engine/prepare", {
        method: "POST",
        headers: { "content-type": "application/pdf" },
        body: pdf,
      })
    );
    if (!res.ok) throw new Error(`engine /prepare ${res.status}`);
    const body = (await res.json()) as { page_count: number };
    return { pageCount: body.page_count };
  };
  const jobId = c.req.param("id");
  const result = await startJob(c.env.DB, c.env.STORE, prepare, jobId, user.id);
  if (!result.ok) {
    const status =
      result.reason === "not_found" ? 404
      : result.reason === "not_startable" ? 409
      : result.reason === "insufficient_credits" ? 402
      : 500;
    const message =
      result.reason === "insufficient_credits" ? "not enough credits for this document"
      : result.reason === "not_startable" ? "this job already started"
      : result.reason === "not_found" ? "not found"
      : "we could not read this file";
    return c.json({ error: message }, status);
  }
  // The job is now in 'processing'; hand it to the OCR queue consumer, which
  // streams the PDF to the container, stores artifacts, and marks it ready.
  await c.env.OCR_QUEUE.send({ jobId });
  return c.json({ ok: true, pageCount: result.pageCount, heldCredits: result.heldMcr / 1000 });
});
