import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, it, expect } from "vitest";
import { allocate, getBalanceMcr, placeHold, captureHold, releaseHold, refundSurcharge } from "../src/ledger";
import { createJob, getJobForUser } from "../src/jobs";
import { countJob, startJob } from "../src/start";
import { finalizeJob, type ProcessFn } from "../src/finalize";
import { app } from "../src/index";
import { createUser } from "./helpers";
import { makeFirebaseMock, type FirebaseMock } from "./firebase-mock";

const tenPages = async (_pdf: ArrayBuffer) => ({ pageCount: 10 });

async function enableEnrich() {
  await env.DB.prepare("UPDATE config SET value = 'test/model' WHERE key = 'enrich_model'").run();
}
async function disableEnrich() {
  await env.DB.prepare("UPDATE config SET value = '' WHERE key = 'enrich_model'").run();
}

async function receivedJob(opts: { fundMcr?: number; enrich?: boolean } = {}) {
  const userId = await createUser();
  if (opts.fundMcr) {
    await allocate(env.DB, { userId, amountMcr: opts.fundMcr, note: null, createdBy: "adnan@thothica.com" });
  }
  await env.STORE.put(`uploads/${userId}/j.pdf`, "%PDF-fake");
  const job = await createJob(env.DB, {
    userId, mode: "reflow", express: false, enrich: opts.enrich ?? false, title: null,
    r2UploadKey: `uploads/${userId}/j.pdf`,
  });
  return { userId, job };
}

// ---------------------------------------------------------------- pricing --
describe("enrichment pricing", () => {
  it("count folds the +0.2/page surcharge into creditsMcr and snapshots the rate", async () => {
    const { userId, job } = await receivedJob({ fundMcr: 50_000, enrich: true });
    const res = await countJob(env.DB, env.STORE, tenPages, job.id, userId);
    // base 900 + surcharge 200 = 1100/page x 10 = 11_000; rateMcr stays base.
    expect(res).toEqual({ ok: true, pageCount: 10, rateMcr: 900, creditsMcr: 11_000 });
    const after = await getJobForUser(env.DB, job.id, userId);
    expect(after!.enrichRateMcr).toBe(200);
    expect(await getBalanceMcr(env.DB, userId)).toBe(50_000); // no hold
  });

  it("count with enrich off is unchanged (surcharge 0)", async () => {
    const { userId, job } = await receivedJob({ enrich: false });
    const res = await countJob(env.DB, env.STORE, tenPages, job.id, userId);
    expect(res).toEqual({ ok: true, pageCount: 10, rateMcr: 900, creditsMcr: 9_000 });
    const after = await getJobForUser(env.DB, job.id, userId);
    expect(after!.enrichRateMcr).toBe(0);
  });

  it("start holds (base+surcharge)*pages and reuses the counted snapshot", async () => {
    const { userId, job } = await receivedJob({ fundMcr: 50_000, enrich: true });
    await countJob(env.DB, env.STORE, tenPages, job.id, userId);
    const res = await startJob(env.DB, env.STORE, tenPages, job.id, userId);
    expect(res).toEqual({ ok: true, pageCount: 10, heldMcr: 11_000 });
    expect(await getBalanceMcr(env.DB, userId)).toBe(39_000); // 50k - 11k
  });

  it("single-file start (no prior count) still snapshots the surcharge and holds it", async () => {
    const { userId, job } = await receivedJob({ fundMcr: 50_000, enrich: true });
    const res = await startJob(env.DB, env.STORE, tenPages, job.id, userId);
    expect(res).toEqual({ ok: true, pageCount: 10, heldMcr: 11_000 });
    const after = await getJobForUser(env.DB, job.id, userId);
    expect(after!.enrichRateMcr).toBe(200); // snapshotted from live config
    expect(await getBalanceMcr(env.DB, userId)).toBe(39_000);
  });

  it("insufficient credits gate accounts for the surcharge", async () => {
    // 10_000 covers base (9_000) but not base+surcharge (11_000).
    const { userId, job } = await receivedJob({ fundMcr: 10_000, enrich: true });
    const res = await startJob(env.DB, env.STORE, tenPages, job.id, userId);
    expect(res).toEqual({ ok: false, reason: "insufficient_credits" });
    expect(await getBalanceMcr(env.DB, userId)).toBe(10_000); // nothing held
  });
});

// ----------------------------------------------------------- refund helper --
describe("refundSurcharge (ledger)", () => {
  it("refunds a captured hold once, and is a no-op the second time", async () => {
    const userId = await createUser();
    await allocate(env.DB, { userId, amountMcr: 11_000, note: null, createdBy: "a@b.c" });
    const hold = await placeHold(env.DB, { userId, jobId: "job-r1", amountMcr: 11_000 });
    expect(hold.ok).toBe(true);
    if (!hold.ok) return;
    await captureHold(env.DB, hold.holdId);
    // 4 of 10 pages not enriched -> refund 4 * 200 = 800.
    expect(await refundSurcharge(env.DB, {
      userId, jobId: "job-r1", holdId: hold.holdId, amountMcr: 800, note: "4/10 pages",
    })).toBe(true);
    expect(await getBalanceMcr(env.DB, userId)).toBe(800); // 11k funded -11k hold +800
    // second call is a no-op (idempotent)
    expect(await refundSurcharge(env.DB, {
      userId, jobId: "job-r1", holdId: hold.holdId, amountMcr: 800, note: "4/10 pages",
    })).toBe(false);
    expect(await getBalanceMcr(env.DB, userId)).toBe(800);
  });

  it("does NOT refund when the hold was released (already fully refunded)", async () => {
    const userId = await createUser();
    await allocate(env.DB, { userId, amountMcr: 11_000, note: null, createdBy: "a@b.c" });
    const hold = await placeHold(env.DB, { userId, jobId: "job-r2", amountMcr: 11_000 });
    if (!hold.ok) return;
    await releaseHold(env.DB, hold.holdId); // full refund incl. surcharge
    expect(await refundSurcharge(env.DB, {
      userId, jobId: "job-r2", holdId: hold.holdId, amountMcr: 800, note: "x",
    })).toBe(false);
    expect(await getBalanceMcr(env.DB, userId)).toBe(11_000); // exactly the funded amount
  });
});

// -------------------------------------------------------------- finalize ----
async function processingEnrichJob(fundMcr = 20_000) {
  const userId = await createUser();
  await allocate(env.DB, { userId, amountMcr: fundMcr, note: null, createdBy: "a@b.c" });
  const key = `uploads/${userId}/j.pdf`;
  await env.STORE.put(key, "%PDF-fake");
  const job = await createJob(env.DB, {
    userId, mode: "reflow", express: false, enrich: true, title: "Book", r2UploadKey: key,
  });
  const res = await startJob(env.DB, env.STORE, tenPages, job.id, userId);
  expect(res.ok).toBe(true); // holds 11_000
  return { userId, jobId: job.id };
}

function stub(pagesEnriched: number | undefined): ProcessFn {
  return async (input) => {
    if (input.kind === "stream" && input.body instanceof ReadableStream) {
      await new Response(input.body).arrayBuffer();
    }
    return {
      page_count: 10, verbatim: [], doc_json: {}, markdown: "md", figures: [],
      ...(pagesEnriched === undefined
        ? {}
        : { enrich: { requested: true, pages_total: 10, pages_enriched: pagesEnriched } }),
    };
  };
}

describe("finalize surcharge refund", () => {
  it("all pages enriched: no refund (full surcharge earned)", async () => {
    const { userId, jobId } = await processingEnrichJob();
    expect(await getBalanceMcr(env.DB, userId)).toBe(9_000); // 20k - 11k hold
    expect(await finalizeJob(env, jobId, stub(10))).toBe("ready");
    expect(await getBalanceMcr(env.DB, userId)).toBe(9_000); // charged full 11k
  });

  it("no pages enriched: full surcharge refunded", async () => {
    const { userId, jobId } = await processingEnrichJob();
    expect(await finalizeJob(env, jobId, stub(0))).toBe("ready");
    // charged base only: 20k - 11k + (200*10 refund) = 11_000
    expect(await getBalanceMcr(env.DB, userId)).toBe(11_000);
  });

  it("partial: refunds the surcharge for pages not enriched", async () => {
    const { userId, jobId } = await processingEnrichJob();
    expect(await finalizeJob(env, jobId, stub(6))).toBe("ready"); // 4 pages refunded
    // 20k - 11k + (200*4) = 9_800
    expect(await getBalanceMcr(env.DB, userId)).toBe(9_800);
  });

  it("missing enrich summary refunds the full surcharge (NaN-safe)", async () => {
    const { userId, jobId } = await processingEnrichJob();
    expect(await finalizeJob(env, jobId, stub(undefined))).toBe("ready");
    expect(await getBalanceMcr(env.DB, userId)).toBe(11_000); // full surcharge back
  });

  it("idempotent: a second finalize does not double-refund", async () => {
    const { userId, jobId } = await processingEnrichJob();
    expect(await finalizeJob(env, jobId, stub(6))).toBe("ready");
    const balance = await getBalanceMcr(env.DB, userId);
    expect(await finalizeJob(env, jobId, stub(6))).toBe("skipped");
    expect(await getBalanceMcr(env.DB, userId)).toBe(balance);
  });
});

// --------------------------------------------------------------- routes -----
describe("enrich route gating + config", () => {
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
    token = await fb.tokenFor({ sub: "uid-enrich", email: "enrich@test.dev" });
  });

  const PDF = new TextEncoder().encode("%PDF-1.4 fake");

  it("/api/config reports enrich availability from secret + model config", async () => {
    await disableEnrich();
    let cfg = (await (await app.request("/api/config", {}, env)).json()) as any;
    expect(cfg.enrich).toEqual({ available: false, rateCredits: 0.2 });
    await enableEnrich();
    cfg = (await (await app.request("/api/config", {}, env)).json()) as any;
    expect(cfg.enrich).toEqual({ available: true, rateCredits: 0.2 });
  });

  it("POST / rejects enrich=1 with 409 when the add-on is unconfigured", async () => {
    await disableEnrich();
    const res = await app.request(
      "/api/jobs?mode=reflow&enrich=1",
      { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/pdf" }, body: PDF },
      env
    );
    expect(res.status).toBe(409);
  });

  it("POST / accepts and persists enrich=1 when configured", async () => {
    await enableEnrich();
    const res = await app.request(
      "/api/jobs?mode=reflow&enrich=1",
      { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/pdf" }, body: PDF },
      env
    );
    expect(res.status).toBe(200);
    const job = (await res.json()) as { id: string; enrich: boolean };
    expect(job.enrich).toBe(true);
    const row = await env.DB.prepare("SELECT enrich FROM jobs WHERE id = ?1").bind(job.id).first<{ enrich: number }>();
    expect(row!.enrich).toBe(1);
  });
});
