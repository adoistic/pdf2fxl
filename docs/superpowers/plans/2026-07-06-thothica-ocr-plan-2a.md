# Thothica OCR SaaS, plan 2a of 7: jobs, upload, container platform, prepare + hold

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user can upload a PDF, a Cloudflare Container running the pdf2fxl engine counts its pages, and credits are held at the correct per-page rate, all deployed and verified. Express OCR itself, artifacts, and downloads follow in plan 2b.

**Architecture:** The container is pure compute: no D1, no R2, no secrets beyond what a request carries. The Worker streams the PDF to the container and owns every storage write. Data path: client -> Worker -> R2 `uploads/`; Worker -> container `/prepare` (PDF bytes in, page count out) -> ledger hold -> job state machine in D1. Orchestration lives in a pure function taking an injected engine callback, so worker tests need no container.

**Tech Stack:** Existing worker stack + R2 binding, `@cloudflare/containers` (Durable Object base class), Cloudflare Containers (python:3.13-slim image, FastAPI, standard-1 instance), PyMuPDF from the existing engine.

**Grounded facts (retrieved 2026-07-06, do not re-derive):** containers config lives in wrangler.jsonc as `"containers": [{ "class_name", "image", "max_instances", "instance_type" }]`; the class must be a Durable Object registered via `"migrations": [{ "tag": "v1", "new_sqlite_classes": ["..."] }]` and bound via `durable_objects.bindings`; the image must build for linux/amd64; instance_type `standard-1` = 1/2 vCPU, 4 GiB memory, 8 GB disk; `wrangler deploy` builds and pushes the image automatically (Docker required locally); first provisioning takes a few minutes and requests error until ready.

**Execution notes:**
- Working directory `cloud/worker/` unless stated. Python tasks use the repo venv (`.venv/bin/python`).
- Do not touch `src/pdf2fxl/` (engine) except read-only imports from the container app.
- Deployed end-to-end verification with real auth is limited until Adnan runs `firebase login --reauth` (FIREBASE_PROJECT_ID is still ""). Task 9 verifies as far as possible without it and states what remains.
- Commits end with the Co-Authored-By trailer. Never push unless the task says so.

---

### Task 1: Jobs table migration

**Files:**
- Create: `cloud/worker/migrations/0002_jobs.sql`
- Test: `cloud/worker/test/jobs-schema.test.ts`

- [ ] **Step 1: Write the failing test**

`cloud/worker/test/jobs-schema.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createUser } from "./helpers";

describe("jobs schema", () => {
  it("has the jobs table with defaults", async () => {
    const userId = await createUser();
    await env.DB.prepare(
      "INSERT INTO jobs (id, user_id, mode, r2_upload_key) VALUES ('j1', ?1, 'reflow', 'uploads/x/j1.pdf')"
    ).bind(userId).run();
    const row = await env.DB.prepare("SELECT * FROM jobs WHERE id = 'j1'").first<Record<string, unknown>>();
    expect(row!.status).toBe("received");
    expect(row!.express).toBe(0);
    expect(row!.page_count).toBeNull();
    expect(row!.hold_id).toBeNull();
  });

  it("rejects invalid mode and status", async () => {
    const userId = await createUser();
    await expect(
      env.DB.prepare("INSERT INTO jobs (id, user_id, mode) VALUES ('j2', ?1, 'sideways')").bind(userId).run()
    ).rejects.toThrow(/CHECK/);
    await expect(
      env.DB.prepare(
        "INSERT INTO jobs (id, user_id, mode, status) VALUES ('j3', ?1, 'reflow', 'daydreaming')"
      ).bind(userId).run()
    ).rejects.toThrow(/CHECK/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd "cloud/worker" && npx vitest run test/jobs-schema.test.ts` — expect FAIL (no such table: jobs).

- [ ] **Step 3: Write the migration**

`cloud/worker/migrations/0002_jobs.sql`:

```sql
-- Jobs. One row per uploaded document. Status transitions are guarded in
-- application code by conditional UPDATE ... WHERE status = ?, so a job can
-- never be finalized twice; the CHECK lists every legal state.
-- Plan 2a drives received -> preparing -> processing (hold placed) or failed;
-- later plans add the OCR and delivery transitions.
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  bulk_id TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('reflow', 'fixed')),
  express INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN
    ('received', 'preparing', 'awaiting_ocr', 'processing', 'assembling', 'ready', 'failed')),
  title TEXT,
  page_count INTEGER,
  rate_mcr INTEGER,
  hold_id INTEGER REFERENCES credit_ledger(id),
  batch_id TEXT,
  r2_upload_key TEXT,
  r2_verbatim_key TEXT,
  r2_doc_key TEXT,
  r2_md_key TEXT,
  engine_version TEXT,
  error_public TEXT,
  error_internal TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX ix_jobs_user ON jobs(user_id);
CREATE INDEX ix_jobs_status ON jobs(status);
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/jobs-schema.test.ts` then full `npx vitest run` — expect 52 passed (50 + 2).

- [ ] **Step 5: Commit**

```bash
git add cloud/worker/migrations/0002_jobs.sql cloud/worker/test/jobs-schema.test.ts
git commit -m "feat(saas): jobs table with guarded state machine schema"
```

---

### Task 2: R2 binding and bucket

**Files:**
- Modify: `cloud/worker/wrangler.jsonc`
- Modify: `cloud/worker/src/types.ts`
- Test: `cloud/worker/test/r2.test.ts`

- [ ] **Step 1: Failing test**

`cloud/worker/test/r2.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("r2 binding", () => {
  it("round-trips an object", async () => {
    await env.STORE.put("uploads/test/echo.pdf", "hello");
    const obj = await env.STORE.get("uploads/test/echo.pdf");
    expect(await obj!.text()).toBe("hello");
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/r2.test.ts` fails (STORE undefined / type error).

- [ ] **Step 3: Implement**

wrangler.jsonc, add sibling of `d1_databases`:

```jsonc
  "r2_buckets": [
    { "binding": "STORE", "bucket_name": "thothica-ocr" }
  ],
```

`src/types.ts`: add `STORE: R2Bucket;` to `Env`.

- [ ] **Step 4: Run to verify pass** — full suite 53 passed. (Miniflare provisions a local R2 from config; no real bucket needed for tests.)

- [ ] **Step 5: Create the real bucket and commit**

Run: `npx wrangler r2 bucket create thothica-ocr` (expect success; bucket name matches config).

```bash
git add cloud/worker/wrangler.jsonc cloud/worker/src/types.ts cloud/worker/test/r2.test.ts
git commit -m "feat(saas): R2 store binding and production bucket"
```

---

### Task 3: Jobs module (state machine and queries)

**Files:**
- Create: `cloud/worker/src/jobs.ts`
- Test: `cloud/worker/test/jobs.test.ts`

- [ ] **Step 1: Failing tests**

`cloud/worker/test/jobs.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createJob, getJobForUser, listJobsForUser, transition, failJob } from "../src/jobs";
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
    expect((await listJobsForUser(env.DB, owner)).map((j) => j.id)).toEqual([job.id]);
  });

  it("transitions only from the expected state", async () => {
    const owner = await createUser();
    const job = await createJob(env.DB, {
      userId: owner, mode: "reflow", express: true, title: null, r2UploadKey: "k",
    });
    expect(await transition(env.DB, job.id, "received", "preparing")).toBe(true);
    expect(await transition(env.DB, job.id, "received", "preparing")).toBe(false); // stale
    expect(
      await transition(env.DB, job.id, "preparing", "processing", { page_count: 12, rate_mcr: 900, hold_id: 1 })
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
});
```

- [ ] **Step 2: Run to verify failure** — cannot resolve `../src/jobs`.

- [ ] **Step 3: Implement**

`cloud/worker/src/jobs.ts`:

```ts
// Job state machine. Every transition is a conditional UPDATE guarded by the
// expected current status, so concurrent workers cannot double-drive a job.

export type JobMode = "reflow" | "fixed";
export type JobStatus =
  | "received" | "preparing" | "awaiting_ocr" | "processing"
  | "assembling" | "ready" | "failed";

export interface Job {
  id: string;
  userId: number;
  mode: JobMode;
  express: boolean;
  status: JobStatus;
  title: string | null;
  pageCount: number | null;
  rateMcr: number | null;
  holdId: number | null;
  r2UploadKey: string | null;
  errorPublic: string | null;
  createdAt: string;
}

type JobRow = {
  id: string; user_id: number; mode: JobMode; express: number; status: JobStatus;
  title: string | null; page_count: number | null; rate_mcr: number | null;
  hold_id: number | null; r2_upload_key: string | null; error_public: string | null;
  created_at: string;
};

const COLS =
  "id, user_id, mode, express, status, title, page_count, rate_mcr, hold_id, r2_upload_key, error_public, created_at";

function toJob(r: JobRow): Job {
  return {
    id: r.id, userId: r.user_id, mode: r.mode, express: r.express === 1,
    status: r.status, title: r.title, pageCount: r.page_count, rateMcr: r.rate_mcr,
    holdId: r.hold_id, r2UploadKey: r.r2_upload_key, errorPublic: r.error_public,
    createdAt: r.created_at,
  };
}

export async function createJob(
  db: D1Database,
  opts: { userId: number; mode: JobMode; express: boolean; title: string | null; r2UploadKey: string }
): Promise<Job> {
  const id = crypto.randomUUID();
  const row = await db
    .prepare(
      `INSERT INTO jobs (id, user_id, mode, express, title, r2_upload_key)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING ${COLS}`
    )
    .bind(id, opts.userId, opts.mode, opts.express ? 1 : 0, opts.title, opts.r2UploadKey)
    .first<JobRow>();
  return toJob(row!);
}

export async function getJobForUser(db: D1Database, id: string, userId: number): Promise<Job | null> {
  const row = await db
    .prepare(`SELECT ${COLS} FROM jobs WHERE id = ?1 AND user_id = ?2`)
    .bind(id, userId)
    .first<JobRow>();
  return row ? toJob(row) : null;
}

export async function listJobsForUser(db: D1Database, userId: number): Promise<Job[]> {
  const { results } = await db
    .prepare(`SELECT ${COLS} FROM jobs WHERE user_id = ?1 ORDER BY created_at DESC, id DESC`)
    .bind(userId)
    .all<JobRow>();
  return results.map(toJob);
}

// Extra columns settable on transition. Keys are whitelisted, never caller input.
const TRANSITION_COLS = ["page_count", "rate_mcr", "hold_id", "batch_id", "engine_version"] as const;
type TransitionExtra = Partial<Record<(typeof TRANSITION_COLS)[number], string | number>>;

export async function transition(
  db: D1Database,
  id: string,
  from: JobStatus,
  to: JobStatus,
  extra: TransitionExtra = {}
): Promise<boolean> {
  const sets = ["status = ?1", "updated_at = datetime('now')"];
  const binds: (string | number)[] = [to];
  for (const col of TRANSITION_COLS) {
    const val = extra[col];
    if (val !== undefined) {
      binds.push(val);
      sets.push(`${col} = ?${binds.length}`);
    }
  }
  binds.push(id, from);
  const res = await db
    .prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?${binds.length - 1} AND status = ?${binds.length}`)
    .bind(...binds)
    .run();
  return res.meta.changes === 1;
}

export async function failJob(
  db: D1Database,
  id: string,
  from: JobStatus,
  errorPublic: string,
  errorInternal: string
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE jobs SET status = 'failed', error_public = ?1, error_internal = ?2,
       updated_at = datetime('now') WHERE id = ?3 AND status = ?4`
    )
    .bind(errorPublic, errorInternal, id, from)
    .run();
  return res.meta.changes === 1;
}
```

- [ ] **Step 4: Run to verify pass** — full suite 56 passed.

- [ ] **Step 5: Commit**

```bash
git add cloud/worker/src/jobs.ts cloud/worker/test/jobs.test.ts
git commit -m "feat(saas): job state machine with guarded transitions"
```

---

### Task 4: Upload route (POST /api/jobs) and job listing routes

**Files:**
- Create: `cloud/worker/src/routes/jobs.ts`
- Modify: `cloud/worker/src/index.ts`
- Test: `cloud/worker/test/jobs-routes.test.ts`

- [ ] **Step 1: Failing tests**

`cloud/worker/test/jobs-routes.test.ts` (reuse the JWKS/fetchMock boilerplate exactly as in `test/admin.test.ts`; one user token `uid-up`, email `up@test.dev`):

```ts
import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, it, expect } from "vitest";
import app from "../src/index";
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
  token = await fb.tokenFor({ sub: "uid-up", email: "up@test.dev" });
});

const PDF_BYTES = new TextEncoder().encode("%PDF-1.4 fake body for upload tests");

function upload(params: string, body: BodyInit | null, headers: Record<string, string> = {}) {
  return app.request(
    `/api/jobs?${params}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/pdf", ...headers },
      body,
    },
    env
  );
}

describe("job upload", () => {
  it("accepts a pdf, stores it in R2, creates a received job", async () => {
    const res = await upload("mode=reflow&express=1&title=My%20Scan", PDF_BYTES);
    expect(res.status).toBe(200);
    const job = (await res.json()) as { id: string; status: string; mode: string; express: boolean };
    expect(job.status).toBe("received");
    expect(job.mode).toBe("reflow");
    expect(job.express).toBe(true);
    const row = await env.DB.prepare("SELECT r2_upload_key, title FROM jobs WHERE id = ?1")
      .bind(job.id).first<{ r2_upload_key: string; title: string }>();
    expect(row!.title).toBe("My Scan");
    const stored = await env.STORE.get(row!.r2_upload_key);
    expect(await stored!.text()).toContain("%PDF");
  });

  it("rejects non-pdf bodies and bad params", async () => {
    expect((await upload("mode=reflow", new TextEncoder().encode("not a pdf"))).status).toBe(400);
    expect((await upload("mode=sideways", PDF_BYTES)).status).toBe(400);
    expect((await upload("mode=reflow", null)).status).toBe(400);
  });

  it("rejects oversized uploads by content-length", async () => {
    const res = await upload("mode=reflow", PDF_BYTES, { "content-length": String(300 * 1024 * 1024) });
    expect(res.status).toBe(413);
  });

  it("lists and fetches only the caller's jobs", async () => {
    const mine = await (await upload("mode=reflow", PDF_BYTES)).json() as { id: string };
    const list = await app.request("/api/jobs", { headers: { Authorization: `Bearer ${token}` } }, env);
    const body = (await list.json()) as { jobs: { id: string }[] };
    expect(body.jobs.some((j) => j.id === mine.id)).toBe(true);
    const one = await app.request(`/api/jobs/${mine.id}`, { headers: { Authorization: `Bearer ${token}` } }, env);
    expect(one.status).toBe(200);
    const other = await fb.tokenFor({ sub: "uid-other", email: "other@test.dev" });
    const denied = await app.request(`/api/jobs/${mine.id}`, { headers: { Authorization: `Bearer ${other}` } }, env);
    expect(denied.status).toBe(404);
  });

  it("requires auth", async () => {
    const res = await app.request("/api/jobs", { method: "POST", body: PDF_BYTES }, env);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run to verify failure** — 404s (routes missing).

- [ ] **Step 3: Implement**

`cloud/worker/src/routes/jobs.ts`:

```ts
import { Hono } from "hono";
import type { AppUser, Env } from "../types";
import { createJob, getJobForUser, listJobsForUser, type Job, type JobMode } from "../jobs";

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // ~300 scanned pages with headroom

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
    userId: user.id, mode: mode as JobMode, express, title, r2UploadKey: key,
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
```

Note: `createJob` generates its own id; the route pre-computes `id` only for the R2 key. To keep one id, change `createJob` to accept an optional `id` (add `id?: string` to its opts and use `opts.id ?? crypto.randomUUID()`), pass the route's `id` in, and extend the Task 3 test to cover the explicit-id path. Do this as part of this task.

`src/index.ts`: add

```ts
import { jobs } from "./routes/jobs";
```

and before the admin lines:

```ts
app.use("/api/jobs", authRequired);
app.use("/api/jobs/*", authRequired);
app.route("/api/jobs", jobs);
```

- [ ] **Step 4: Run to verify pass** — full suite 61 passed (56 + 5). `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add cloud/worker/src/routes/jobs.ts cloud/worker/src/jobs.ts cloud/worker/src/index.ts cloud/worker/test/jobs-routes.test.ts cloud/worker/test/jobs.test.ts
git commit -m "feat(saas): pdf upload to R2 and job listing routes"
```

---

### Task 5: Container app (FastAPI /prepare)

**Files:**
- Create: `cloud/container/app.py`
- Create: `cloud/container/requirements.txt`
- Test: `tests/container/test_app.py` (repo root tests dir; runs with the repo venv)

- [ ] **Step 1: Failing test**

`tests/container/test_app.py`:

```python
import io

import pymupdf
import pytest
from fastapi.testclient import TestClient

from cloud.container.app import app

client = TestClient(app)


def make_pdf(pages: int) -> bytes:
    doc = pymupdf.open()
    for _ in range(pages):
        doc.new_page(width=300, height=400)
    return doc.tobytes()


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"ok": True}


def test_prepare_counts_pages():
    r = client.post(
        "/prepare",
        content=make_pdf(7),
        headers={"content-type": "application/pdf"},
    )
    assert r.status_code == 200
    assert r.json() == {"page_count": 7}


def test_prepare_rejects_garbage():
    r = client.post("/prepare", content=b"not a pdf")
    assert r.status_code == 422
    assert "detail" in r.json()
```

Add an `__init__.py`? No: pytest with rootdir at repo root imports `cloud.container.app` only if `cloud/` and `cloud/container/` are importable. Create empty `cloud/__init__.py` and `cloud/container/__init__.py` as part of this task so the import works without packaging changes.

- [ ] **Step 2: Run to verify failure**

Run: `cd "/Users/siraj/fixed layout pdf to epub" && .venv/bin/python -m pytest -q tests/container/` — expect import error (module does not exist).

- [ ] **Step 3: Implement**

`cloud/container/app.py`:

```python
"""Internal compute service for Thothica OCR.

Pure compute: no storage, no database, no credentials of its own. The Worker
streams bytes in and persists whatever comes back. Never expose this service
publicly; it is reached only through the Worker's container binding.
"""

import pymupdf
from fastapi import FastAPI, HTTPException, Request

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/prepare")
async def prepare(request: Request) -> dict:
    pdf_bytes = await request.body()
    try:
        doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    except Exception as exc:  # pymupdf raises generic errors on bad input
        raise HTTPException(status_code=422, detail="unreadable pdf") from exc
    try:
        return {"page_count": doc.page_count}
    finally:
        doc.close()
```

`cloud/container/requirements.txt`:

```
fastapi
uvicorn
pymupdf
```

- [ ] **Step 4: Run to verify pass**

Run: `.venv/bin/python -m pytest -q tests/container/` — 3 passed. Then the engine fast suite still passes: `.venv/bin/python -m pytest -q -m 'not slow'` — expect 85 passed total or engine 82 + container 3 depending on collection; report the numbers.

- [ ] **Step 5: Commit**

```bash
git add cloud/container tests/container cloud/__init__.py
git commit -m "feat(saas): container compute service with /prepare page count"
```

---

### Task 6: Dockerfile for the container

**Files:**
- Create: `cloud/container/Dockerfile`
- Create: `cloud/container/.dockerignore`

- [ ] **Step 1: Write the Dockerfile**

`cloud/container/Dockerfile` (build context will be the repo root via `image_build_context`, so paths are repo-relative):

```dockerfile
FROM python:3.13-slim

WORKDIR /srv

COPY cloud/container/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY cloud/container/app.py ./app.py

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
```

(Plan 2b will extend this to install the pdf2fxl engine from `src/`; keeping the copy list explicit now means the image stays small and rebuilds fast.)

`cloud/container/.dockerignore`:

```
**/__pycache__
**/.pytest_cache
```

- [ ] **Step 2: Build and smoke-test locally (Docker required)**

```bash
cd "/Users/siraj/fixed layout pdf to epub"
docker build --platform linux/amd64 -f cloud/container/Dockerfile -t thothica-ocr-engine:dev .
docker run -d --rm --platform linux/amd64 -p 18000:8000 --name ocr-smoke thothica-ocr-engine:dev
sleep 3
curl -s http://127.0.0.1:18000/health
docker stop ocr-smoke
```

Expected: `{"ok":true}`. If Docker is not installed or the daemon is not running, report BLOCKED with the exact error; do not work around it.

- [ ] **Step 3: Commit**

```bash
git add cloud/container/Dockerfile cloud/container/.dockerignore
git commit -m "feat(saas): container image for the compute service"
```

---

### Task 7: Container binding in the Worker

**Files:**
- Modify: `cloud/worker/wrangler.jsonc`
- Modify: `cloud/worker/package.json` (add dependency)
- Create: `cloud/worker/src/container.ts`
- Modify: `cloud/worker/src/index.ts` (export the DO class)

- [ ] **Step 1: Install the containers helper**

Run: `cd cloud/worker && npm install @cloudflare/containers`

- [ ] **Step 2: Implement the Durable Object class**

`cloud/worker/src/container.ts`:

```ts
import { Container } from "@cloudflare/containers";
import type { Env } from "./types";

// The engine container: FastAPI on :8000, pure compute. One named instance
// ("engine") is enough for plan 2a; scaling comes with the batch pipeline.
export class OcrEngine extends Container<Env> {
  defaultPort = 8000;
  sleepAfter = "10m";
}
```

`src/index.ts`: add `export { OcrEngine } from "./container";` at the bottom (workerd discovers DO classes from the entrypoint's exports).

`src/types.ts`: add to Env:

```ts
  OCR_ENGINE: DurableObjectNamespace;
```

- [ ] **Step 3: Wire wrangler.jsonc**

Add to `cloud/worker/wrangler.jsonc`:

```jsonc
  "containers": [
    {
      "class_name": "OcrEngine",
      "image": "../container/Dockerfile",
      "image_build_context": "../..",
      "max_instances": 1,
      "instance_type": "standard-1"
    }
  ],
  "durable_objects": {
    "bindings": [
      { "name": "OCR_ENGINE", "class_name": "OcrEngine" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["OcrEngine"] }
  ],
```

Verify the field names against the installed schema before committing: `python3 -c "import json; s=json.load(open('node_modules/wrangler/config-schema.json')); print('image_build_context' in json.dumps(s))"` — if the field is named differently (for example `build_context`), use the schema's name and note it in your report.

- [ ] **Step 4: Confirm the test suite still runs**

Run: `npx vitest run`. Containers in miniflare need Docker; if the suite now fails to START because of the containers config (not because of a real test regression), report the exact error and stop — the controller will decide between requiring Docker for tests or splitting deploy-only config. If the suite passes (61 tests), continue.

- [ ] **Step 5: Commit**

```bash
git add cloud/worker/wrangler.jsonc cloud/worker/package.json cloud/worker/package-lock.json cloud/worker/src/container.ts cloud/worker/src/index.ts cloud/worker/src/types.ts
git commit -m "feat(saas): OcrEngine container binding via durable object"
```

---

### Task 8: Start route — prepare, price, hold

**Files:**
- Create: `cloud/worker/src/start.ts`
- Modify: `cloud/worker/src/routes/jobs.ts`
- Test: `cloud/worker/test/start.test.ts`

- [ ] **Step 1: Failing tests**

`cloud/worker/test/start.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Run to verify failure** — cannot resolve `../src/start`.

- [ ] **Step 3: Implement**

`cloud/worker/src/start.ts`:

```ts
import { placeHold } from "./ledger";
import { failJob, getJobForUser, transition } from "./jobs";

// The engine callback is injected so tests never need a running container:
// the route passes the real container fetch, tests pass stubs.
export type EnginePrepare = (pdf: ArrayBuffer) => Promise<{ pageCount: number }>;

export type StartResult =
  | { ok: true; pageCount: number; heldMcr: number }
  | { ok: false; reason: "not_startable" | "insufficient_credits" | "engine_error" | "not_found" };

async function rateFor(db: D1Database, mode: string, express: boolean): Promise<number> {
  const keys = mode === "fixed" ? "rate_fixed_mcr" : "rate_reflow_mcr";
  const { results } = await db
    .prepare("SELECT key, value FROM config WHERE key IN (?1, 'express_surcharge_mcr')")
    .bind(keys)
    .all<{ key: string; value: string }>();
  const cfg = Object.fromEntries(results.map((r) => [r.key, Number(r.value)]));
  return cfg[keys] + (express ? cfg.express_surcharge_mcr : 0);
}

export async function startJob(
  db: D1Database,
  store: R2Bucket,
  prepare: EnginePrepare,
  jobId: string,
  userId: number
): Promise<StartResult> {
  const job = await getJobForUser(db, jobId, userId);
  if (!job) return { ok: false, reason: "not_found" };
  if (!(await transition(db, jobId, "received", "preparing"))) {
    return { ok: false, reason: "not_startable" };
  }

  let pageCount: number;
  try {
    const obj = await store.get(job.r2UploadKey!);
    if (!obj) throw new Error(`upload missing in R2: ${job.r2UploadKey}`);
    const res = await prepare(await obj.arrayBuffer());
    pageCount = res.pageCount;
    if (!Number.isSafeInteger(pageCount) || pageCount <= 0) {
      throw new Error(`engine returned page_count ${pageCount}`);
    }
  } catch (err) {
    await failJob(db, jobId, "preparing", "we could not read this file", String(err));
    return { ok: false, reason: "engine_error" };
  }

  const rateMcr = await rateFor(db, job.mode, job.express);
  const amountMcr = rateMcr * pageCount;
  const hold = await placeHold(db, { userId, jobId, amountMcr });
  if (!hold.ok) {
    await failJob(
      db, jobId, "preparing",
      "not enough credits for this document", `needed ${amountMcr} mcr`
    );
    return { ok: false, reason: "insufficient_credits" };
  }

  await transition(db, jobId, "preparing", "processing", {
    page_count: pageCount, rate_mcr: rateMcr, hold_id: hold.holdId,
  });
  return { ok: true, pageCount, heldMcr: amountMcr };
}
```

Append the route to `cloud/worker/src/routes/jobs.ts`:

```ts
import { startJob } from "../start";

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
  const result = await startJob(c.env.DB, c.env.STORE, prepare, c.req.param("id"), user.id);
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
  return c.json({ ok: true, pageCount: result.pageCount, heldCredits: result.heldMcr / 1000 });
});
```

(Note `getByName` per the containers docs; if the installed @cloudflare/containers version exposes a different accessor, follow the package README and note the deviation.)

- [ ] **Step 4: Run to verify pass** — full suite 67 passed (61 + 6). `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add cloud/worker/src/start.ts cloud/worker/src/routes/jobs.ts cloud/worker/test/start.test.ts
git commit -m "feat(saas): job start with engine page count, pricing and credit hold"
```

---

### Task 9: Deploy and verify

Invoke the `wrangler` skill first. All commands from `cloud/worker/`. Docker must be running (image build).

- [ ] **Step 1: Deploy**

Run: `npx wrangler deploy` — expect the container image to build and push (first time is slow), then the Worker deploy with DB, STORE, ASSETS, OCR_ENGINE bindings listed. Containers take a few minutes to provision after first deploy.

- [ ] **Step 2: Verify unauthenticated surfaces**

```bash
BASE="https://thothica-ocr.appsadoistic.workers.dev"
curl -s "$BASE/api/health"                       # {"ok":true}
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/api/jobs?mode=reflow"   # 401
curl -s "$BASE/api/nope"                         # {"error":"not found"}
```

- [ ] **Step 3: Verify the container provisioned**

Run: `npx wrangler containers list` — expect OcrEngine listed. Then `npx wrangler tail --format pretty` in the background is optional for debugging; do not leave it running.

- [ ] **Step 4: State the auth-gated gap honestly**

Full end-to-end (upload -> start -> hold visible in the admin statement) needs a real Firebase ID token, which needs FIREBASE_PROJECT_ID configured — still blocked on Adnan running `firebase login --reauth`. Record in the report: what was verified live (health, 401 gates, 404 envelope, container provisioned) and what remains gated (authenticated upload/start against production).

- [ ] **Step 5: Run everything once more and commit any config drift**

`npx vitest run` (67), `npx tsc --noEmit` (clean), engine suite (`cd ../.. && .venv/bin/python -m pytest -q -m 'not slow'`). Commit only if wrangler.jsonc changed during deploy debugging; otherwise nothing to commit.

---

## Not in this plan (plan 2b and later)

Express OCR against Mistral (realtime), verbatim + normalized artifact writes to R2, on-demand EPUB/MD/DOCX rendering and signed downloads, per-page progress, batch JSONL pipeline + cron + email, fixed layout, bulk, admin UI, retention sweeps, ocrwithai.com cutover, Firebase web config + login page (needs reauth).
