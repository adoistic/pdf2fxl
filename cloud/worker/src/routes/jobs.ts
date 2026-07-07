import { Hono } from "hono";
import type { AppUser, Env } from "../types";
import { createJob, getJobForUser, listJobsForUser, type Job, type JobMode } from "../jobs";
import { startJob, countJob, type EnginePrepare } from "../start";
import { buildDownload, type RenderFn } from "../download";
import { r2DirectEnabled, presignPut } from "../presign";
import { enrichConfig } from "../enrich";

// Send a PDF to the container's /prepare and return its page count. Shared by
// the count and start routes; injected as a stub in tests.
function containerPrepare(env: Env): EnginePrepare {
  return async (pdf: ArrayBuffer) => {
    const engine = env.OCR_ENGINE.getByName("engine");
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
}

// Deliverable ceiling: the body is buffered in the isolate (128MB memory) and
// the edge caps request bodies near this size anyway. Larger scans need the
// streaming upload planned for 2b, not a bigger constant.
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export const jobs = new Hono<{ Bindings: Env; Variables: { user: AppUser } }>();

function publicJob(j: Job) {
  return {
    id: j.id, bulkId: j.bulkId, mode: j.mode, express: j.express, enrich: j.enrich,
    status: j.status, title: j.title, pageCount: j.pageCount, error: j.errorPublic,
    createdAt: j.createdAt,
  };
}

jobs.post("/", async (c) => {
  const user = c.get("user");
  const mode = c.req.query("mode");
  const title = c.req.query("title")?.slice(0, 200) || null;
  // Optional bulk-group id: many books uploaded together share one bulkId so the
  // front end can group them. Bounded to a uuid-ish token.
  const bulkId = c.req.query("bulk")?.slice(0, 64) || null;
  // Emphasis enrichment add-on (+0.2/page). Reject early if the box was checked
  // but the add-on is not configured, so it never silently no-ops.
  const enrich = c.req.query("enrich") === "1";
  if (mode !== "reflow" && mode !== "fixed") {
    return c.json({ error: "mode must be reflow or fixed" }, 400);
  }
  if (enrich && !(await enrichConfig(c.env)).available) {
    return c.json({ error: "the emphasis add-on is not available right now" }, 409);
  }
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > MAX_UPLOAD_BYTES) {
    return c.json({ error: "file is too large" }, 413);
  }
  const id = crypto.randomUUID();
  const key = `uploads/${user.id}/${id}.pdf`;

  // Direct-to-R2: create the job and hand back a short-lived presigned PUT URL.
  // The browser PUTs the PDF straight to R2, so the Worker never sees the bytes;
  // /start then reads the PDF from R2. Requires the R2 secrets to be set.
  if (c.req.query("direct") === "1") {
    if (!r2DirectEnabled(c.env)) {
      return c.json({ error: "direct upload is not available" }, 409);
    }
    const job = await createJob(c.env.DB, {
      id, userId: user.id, bulkId, mode: mode as JobMode, express: false, enrich, title, r2UploadKey: key,
    });
    const uploadUrl = await presignPut(c.env, key, 900);
    return c.json({ ...publicJob(job), uploadUrl });
  }

  const body = c.req.raw.body;
  if (!body) {
    return c.json({ error: "attach a PDF as the request body" }, 400);
  }
  // Streaming fallback (no R2 token yet): stream the request body straight to R2
  // (it carries a known content-length), so the Worker never buffers the whole
  // file in its 128MB isolate. PDF validity is verified by the container's
  // /prepare at start, which returns a clean "we could not read this file".
  await c.env.STORE.put(key, body, { httpMetadata: { contentType: "application/pdf" } });
  const job = await createJob(c.env.DB, {
    id, userId: user.id, bulkId, mode: mode as JobMode, express: false, enrich, title, r2UploadKey: key,
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

// Count a job's pages and store the cost up front, without charging. The bulk
// flow counts every book first so the whole batch is priced and gated against the
// balance before any credits are committed.
jobs.post("/:id/count", async (c) => {
  const user = c.get("user");
  const result = await countJob(
    c.env.DB, c.env.STORE, containerPrepare(c.env), c.req.param("id"), user.id
  );
  if (!result.ok) {
    const status =
      result.reason === "not_found" ? 404
      : result.reason === "not_countable" ? 409
      : 500;
    const message =
      result.reason === "not_found" ? "not found"
      : result.reason === "not_countable" ? "this document already started"
      : "we could not read this file";
    return c.json({ error: message }, status);
  }
  return c.json({ pageCount: result.pageCount, creditsNeeded: result.creditsMcr / 1000 });
});

jobs.post("/:id/start", async (c) => {
  const user = c.get("user");
  const jobId = c.req.param("id");
  const result = await startJob(c.env.DB, c.env.STORE, containerPrepare(c.env), jobId, user.id);
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

// Render EPUB/DOCX on demand from the stored doc.json; markdown streams directly.
jobs.get("/:id/download", async (c) => {
  const render: RenderFn = async (docJson, figures, format) => {
    const engine = c.env.OCR_ENGINE.getByName("engine");
    const res = await engine.fetch(
      new Request("http://engine/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc_json: docJson, figures, format }),
      })
    );
    if (!res.ok) throw new Error(`engine /render ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  };
  const result = await buildDownload(
    c.env, c.req.param("id"), c.get("user").id, c.req.query("format") ?? "", render
  );
  if (!result.ok) return c.json({ error: result.error }, result.status);
  // R2-direct: send the browser straight to the presigned R2 url (no auth needed).
  if ("redirect" in result) return c.redirect(result.redirect, 302);
  return new Response(result.body as BodyInit, {
    headers: {
      "content-type": result.contentType,
      "content-disposition": `attachment; filename="${result.filename}"`,
    },
  });
});
