import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, it, expect } from "vitest";
import { app } from "../src/index";
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
    const res = await upload("mode=reflow&title=My%20Scan", PDF_BYTES);
    expect(res.status).toBe(200);
    const job = (await res.json()) as { id: string; status: string; mode: string; express: boolean };
    expect(job.status).toBe("received");
    expect(job.mode).toBe("reflow");
    expect(job.express).toBe(false);
    const row = await env.DB.prepare("SELECT r2_upload_key, title FROM jobs WHERE id = ?1")
      .bind(job.id).first<{ r2_upload_key: string; title: string }>();
    expect(row!.title).toBe("My Scan");
    const stored = await env.STORE.get(row!.r2_upload_key);
    expect(await stored!.text()).toContain("%PDF");
  });

  it("rejects bad params (PDF validity is checked later, at start)", async () => {
    expect((await upload("mode=sideways", PDF_BYTES)).status).toBe(400);
    expect((await upload("mode=reflow", null)).status).toBe(400);
    // A non-PDF body is accepted at upload; the container's /prepare rejects it
    // at start with a clean message, so the Worker never inspects the bytes here.
    expect((await upload("mode=reflow", new TextEncoder().encode("not a pdf"))).status).toBe(200);
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
