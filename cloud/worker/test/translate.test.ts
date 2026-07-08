import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, it, expect } from "vitest";
import { app } from "../src/index";
import { allocate, getBalanceMcr } from "../src/ledger";
import {
  priceWordsMcr,
  translateConfig,
  submitTranslation,
  quoteTranslation,
  capMessage,
  type EngineWordCount,
} from "../src/translate";
import { getTranslation } from "../src/translations";
import { finalizeTranslation, type TranslateFn } from "../src/finalize";
import { createJob } from "../src/jobs";
import { createUser } from "./helpers";
import { makeFirebaseMock, type FirebaseMock } from "./firebase-mock";

let fb: FirebaseMock;
let token: string;       // regular reader
let adminToken: string;  // seeded admin (ADMIN_EMAIL)

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
  token = await fb.tokenFor({ sub: "uid-tr", email: "tr@test.dev" });
  adminToken = await fb.tokenFor({ sub: "uid-tr-admin", email: "adnan@thothica.com" });
});

const countOf = (n: number): EngineWordCount => async () => n;

async function fundedUser(mcr: number): Promise<number> {
  const userId = await createUser();
  await allocate(env.DB, { userId, amountMcr: mcr, note: null, createdBy: "adnan@thothica.com" });
  return userId;
}

async function enableTranslateFor(email: string) {
  await env.DB.prepare(
    "UPDATE users SET translate_enabled = 1 WHERE email = ?1"
  ).bind(email).run();
}

// ------------------------------------------------------------------ pricing --
describe("translation pricing", () => {
  it("charges 500 credits per 350 words, prorated to 2dp of a credit", () => {
    expect(priceWordsMcr(350, 350, 500_000)).toBe(500_000);   // 500.00 cr
    expect(priceWordsMcr(355, 350, 500_000)).toBe(507_140);   // 507.14 cr
    expect(priceWordsMcr(1, 350, 500_000)).toBe(1_430);       // 1.43 cr
    expect(priceWordsMcr(700, 350, 500_000)).toBe(1_000_000); // 1000.00 cr
    expect(priceWordsMcr(2_000, 350, 500_000)).toBe(2_857_140); // 2857.14 cr
    expect(priceWordsMcr(0, 350, 500_000)).toBe(0);
  });

  it("config is available with the fallback provider key and seeded rows", async () => {
    const cfg = await translateConfig(env);
    expect(cfg.available).toBe(true);
    expect(cfg.blockWords).toBe(350);
    expect(cfg.blockMcr).toBe(500_000);
    expect(cfg.maxWords).toBe(2_000);
    expect(cfg.model.length).toBeGreaterThan(0);
  });

  it("config is unavailable when the model row is blank", async () => {
    await env.DB.prepare("UPDATE config SET value = '' WHERE key = 'translate_model'").run();
    expect((await translateConfig(env)).available).toBe(false);
    await env.DB.prepare(
      "UPDATE config SET value = 'test/model' WHERE key = 'translate_model'"
    ).run();
  });

  it("quote reports the price and the cap without charging", async () => {
    const cfg = await translateConfig(env);
    const q = await quoteTranslation(cfg, countOf(355), { kind: "text", text: "x" });
    expect(q).toEqual({ words: 355, credits: 507.14, maxWords: 2_000, tooLong: false });
    const over = await quoteTranslation(cfg, countOf(2_001), { kind: "text", text: "x" });
    expect(over.tooLong).toBe(true);
  });
});

// ------------------------------------------------------------------- submit --
describe("submitTranslation", () => {
  it("stores the source, snapshots pricing, places the hold, and promotes", async () => {
    const userId = await fundedUser(600_000); // 600 credits
    const cfg = await translateConfig(env);
    const res = await submitTranslation(env.DB, env.STORE, countOf(355), cfg, {
      userId, source: { kind: "text", text: "hello world" },
      jobId: null, title: null, targetLanguage: "Hindi",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const t = res.translation;
    expect(t.status).toBe("processing");
    expect(t.wordCount).toBe(355);
    expect(t.chargedMcr).toBe(507_140);
    expect(t.blockWords).toBe(350);
    expect(await getBalanceMcr(env.DB, userId)).toBe(600_000 - 507_140);
    const stored = await env.STORE.get(t.r2SourceKey!);
    expect(await stored!.text()).toBe("hello world");
  });

  it("refuses more than the word cap with the sorry message, uncharged", async () => {
    const userId = await fundedUser(10_000_000);
    const cfg = await translateConfig(env);
    const res = await submitTranslation(env.DB, env.STORE, countOf(2_001), cfg, {
      userId, source: { kind: "text", text: "long" },
      jobId: null, title: null, targetLanguage: "Hindi",
    });
    expect(res).toEqual({ ok: false, status: 400, error: capMessage(2_001, 2_000) });
    expect(await getBalanceMcr(env.DB, userId)).toBe(10_000_000);
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM translations WHERE user_id = ?1"
    ).bind(userId).first<{ n: number }>();
    expect(rows!.n).toBe(0); // refused before any row or hold
  });

  it("insufficient credits fails the row and leaves the balance whole", async () => {
    const userId = await fundedUser(1_000); // 1 credit, needs 507.14
    const cfg = await translateConfig(env);
    const res = await submitTranslation(env.DB, env.STORE, countOf(355), cfg, {
      userId, source: { kind: "text", text: "hello" },
      jobId: null, title: null, targetLanguage: "Tamil",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(402);
    expect(await getBalanceMcr(env.DB, userId)).toBe(1_000);
  });
});

// ----------------------------------------------------------------- finalize --
const okTranslate: TranslateFn = async (input) => ({
  word_count: 5,
  markdown: "# अनुवाद\n\nनमस्ते\n",
  ...(input.kind === "doc" ? { doc_json: { title: "अनुवाद", nodes: [] } } : {}),
});

async function processingTranslation(kind: "text" | "book", userId: number) {
  const cfg = await translateConfig(env);
  const source =
    kind === "text"
      ? ({ kind: "text", text: "hello world" } as const)
      : ({ kind: "doc", docJson: { title: "Book", language: "en", nodes: [] } } as const);
  const res = await submitTranslation(env.DB, env.STORE, countOf(100), cfg, {
    userId, source, jobId: null, title: kind === "book" ? "Book" : null,
    targetLanguage: "Hindi",
  });
  if (!res.ok) throw new Error("submit failed in fixture");
  return res.translation;
}

describe("finalizeTranslation", () => {
  it("stores outputs, captures the hold, and marks ready", async () => {
    const userId = await fundedUser(1_000_000);
    const t = await processingTranslation("text", userId);
    const out = await finalizeTranslation(env, t.id, okTranslate);
    expect(out).toBe("ready");
    const after = await getTranslation(env.DB, t.id);
    expect(after!.status).toBe("ready");
    expect(after!.r2MdKey).toBe(`translations/${t.id}/normalized.md`);
    const md = await env.STORE.get(after!.r2MdKey!);
    expect(await md!.text()).toContain("अनुवाद");
    // hold captured: the charge stands
    expect(await getBalanceMcr(env.DB, userId)).toBe(1_000_000 - t.chargedMcr!);
  });

  it("a book translation also stores the translated document", async () => {
    const userId = await fundedUser(1_000_000);
    const t = await processingTranslation("book", userId);
    expect(await finalizeTranslation(env, t.id, okTranslate)).toBe("ready");
    const after = await getTranslation(env.DB, t.id);
    expect(after!.r2DocKey).toBe(`translations/${t.id}/normalized.json`);
    const doc = await env.STORE.get(after!.r2DocKey!);
    expect(JSON.parse(await doc!.text()).title).toBe("अनुवाद");
  });

  it("a failed translate releases the hold in full", async () => {
    const userId = await fundedUser(1_000_000);
    const t = await processingTranslation("text", userId);
    const boom: TranslateFn = async () => { throw new Error("model down"); };
    expect(await finalizeTranslation(env, t.id, boom)).toBe("failed");
    const after = await getTranslation(env.DB, t.id);
    expect(after!.status).toBe("failed");
    expect(after!.errorPublic).toContain("credits were not charged");
    expect(await getBalanceMcr(env.DB, userId)).toBe(1_000_000);
  });

  it("is idempotent: a second run after success is skipped", async () => {
    const userId = await fundedUser(1_000_000);
    const t = await processingTranslation("text", userId);
    expect(await finalizeTranslation(env, t.id, okTranslate)).toBe("ready");
    expect(await finalizeTranslation(env, t.id, okTranslate)).toBe("skipped");
    expect(await getBalanceMcr(env.DB, userId)).toBe(1_000_000 - t.chargedMcr!);
  });
});

// -------------------------------------------------------------- route gating --
function get(path: string, tok: string) {
  return app.request(path, { headers: { Authorization: `Bearer ${tok}` } }, env);
}

describe("route gating (hidden per user)", () => {
  it("every /api/translate route is 404 for a user without the flag", async () => {
    const res = await get("/api/translate", token);
    expect(res.status).toBe(404);
  });

  it("flagged users can list; /api/me carries the terms", async () => {
    await get("/api/me", token); // ensure the user row exists
    await enableTranslateFor("tr@test.dev");
    const res = await get("/api/translate", token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ translations: expect.any(Array) });

    const me = await get("/api/me", token);
    const body = (await me.json()) as { translate: { maxWords: number; blockCredits: number } };
    expect(body.translate).toEqual({ maxWords: 2_000, blockWords: 350, blockCredits: 500 });
  });

  it("/api/me carries no translate object without the flag", async () => {
    const other = await fb.tokenFor({ sub: "uid-noflag", email: "noflag@test.dev" });
    const me = await get("/api/me", other);
    const body = (await me.json()) as { translate: unknown };
    expect(body.translate).toBeNull();
  });

  it("the gate hides the feature when the add-on is unconfigured", async () => {
    await env.DB.prepare("UPDATE config SET value = '' WHERE key = 'translate_model'").run();
    const res = await get("/api/translate", token);
    expect(res.status).toBe(404);
    await env.DB.prepare(
      "UPDATE config SET value = 'test/model' WHERE key = 'translate_model'"
    ).run();
  });
});

// -------------------------------------------------------------------- admin --
describe("admin enable/disable", () => {
  it("flips the flag by email, pre-allocation style", async () => {
    const res = await app.request(
      "/api/admin/users/translate",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
        body: JSON.stringify({ email: "new-reader@test.dev", enabled: true }),
      },
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "new-reader@test.dev", translateEnabled: true });
    const row = await env.DB.prepare(
      "SELECT translate_enabled FROM users WHERE email = 'new-reader@test.dev'"
    ).first<{ translate_enabled: number }>();
    expect(row!.translate_enabled).toBe(1);
  });

  it("non-admins cannot touch it and the users list shows the flag", async () => {
    const res = await app.request(
      "/api/admin/users/translate",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ email: "x@test.dev", enabled: true }),
      },
      env
    );
    expect(res.status).toBe(403);
    // flag someone (storage is isolated per test), then read the list
    await app.request(
      "/api/admin/users/translate",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
        body: JSON.stringify({ email: "flagged@test.dev", enabled: true }),
      },
      env
    );
    const list = await get("/api/admin/users", adminToken);
    const body = (await list.json()) as { users: { email: string; translateEnabled: boolean }[] };
    const flagged = body.users.find((u) => u.email === "flagged@test.dev");
    expect(flagged?.translateEnabled).toBe(true);
  });

  it("rejects junk", async () => {
    const res = await app.request(
      "/api/admin/users/translate",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
        body: JSON.stringify({ email: "not-an-email", enabled: "yes" }),
      },
      env
    );
    expect(res.status).toBe(400);
  });
});

// ------------------------------------------------------------------ results --
describe("result and download routes", () => {
  it("serves the translated markdown inline once ready", async () => {
    const meRes = await get("/api/me", token);
    expect(meRes.status).toBe(200);
    await enableTranslateFor("tr@test.dev");
    const userRow = await env.DB.prepare(
      "SELECT id FROM users WHERE email = 'tr@test.dev'"
    ).first<{ id: number }>();
    const userId = userRow!.id;
    await allocate(env.DB, { userId, amountMcr: 1_000_000, note: null, createdBy: "t" });

    const cfg = await translateConfig(env);
    const sub = await submitTranslation(env.DB, env.STORE, countOf(10), cfg, {
      userId, source: { kind: "text", text: "hello" },
      jobId: null, title: null, targetLanguage: "Hindi",
    });
    if (!sub.ok) throw new Error("submit failed");
    await finalizeTranslation(env, sub.translation.id, okTranslate);

    const res = await get(`/api/translate/${sub.translation.id}/result`, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { markdown: string; status: string };
    expect(body.status).toBe("ready");
    expect(body.markdown).toContain("अनुवाद");

    // md download redirects to a presigned R2 url (r2Direct is on in tests)
    const dl = await get(`/api/translate/${sub.translation.id}/download?format=md`, token);
    expect(dl.status).toBe(302);
    expect(dl.headers.get("location")).toContain("normalized.md");

    // a text translation has no book edition
    const epub = await get(`/api/translate/${sub.translation.id}/download?format=epub`, token);
    expect(epub.status).toBe(409);
  });

  it("does not leak another user's translation", async () => {
    const other = await fb.tokenFor({ sub: "uid-other", email: "other@test.dev" });
    await get("/api/me", other);
    await enableTranslateFor("other@test.dev");
    const mine = await env.DB.prepare(
      "SELECT id FROM translations LIMIT 1"
    ).first<{ id: string }>();
    if (!mine) return;
    const res = await get(`/api/translate/${mine.id}`, other);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------- book source --
describe("book source resolution (route level)", () => {
  it("submitting an unready book is refused", async () => {
    await get("/api/me", token);
    await enableTranslateFor("tr@test.dev");
    const userRow = await env.DB.prepare(
      "SELECT id FROM users WHERE email = 'tr@test.dev'"
    ).first<{ id: number }>();
    const job = await createJob(env.DB, {
      userId: userRow!.id, mode: "reflow", express: false, title: "Draft",
      r2UploadKey: `uploads/${userRow!.id}/x.pdf`,
    });
    const res = await app.request(
      "/api/translate",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ kind: "book", jobId: job.id, targetLanguage: "Hindi" }),
      },
      env
    );
    expect(res.status).toBe(409);
  });

  it("bad language and bad kind are rejected early", async () => {
    await get("/api/me", token); // ensure the user row exists (isolated storage)
    await enableTranslateFor("tr@test.dev");
    const bad = await app.request(
      "/api/translate",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ kind: "text", text: "hi", targetLanguage: "" }),
      },
      env
    );
    expect(bad.status).toBe(400);
    const junk = await app.request(
      "/api/translate",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ kind: "zzz", targetLanguage: "Hindi" }),
      },
      env
    );
    expect(junk.status).toBe(400);
  });
});
