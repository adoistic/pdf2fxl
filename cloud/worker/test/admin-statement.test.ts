import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, it, expect } from "vitest";
import app from "../src/index";
import { placeHold, releaseHold } from "../src/ledger";
import { makeFirebaseMock, type FirebaseMock } from "./firebase-mock";

let fb: FirebaseMock;
let adminToken: string;

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
  adminToken = await fb.tokenFor({ sub: "uid-adnan", email: "adnan@thothica.com" });
});

describe("admin statement", () => {
  it("returns the full ledger for one user, newest first", async () => {
    await app.request(
      "/api/admin/credits",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
        body: JSON.stringify({ email: "stmt@test.dev", credits: 10, note: "start" }),
      },
      env
    );
    const user = await env.DB.prepare("SELECT id FROM users WHERE email = 'stmt@test.dev'").first<{ id: number }>();
    const hold = await placeHold(env.DB, { userId: user!.id, jobId: "job-s", amountMcr: 700 });
    if (!hold.ok) throw new Error("setup failed");
    await releaseHold(env.DB, hold.holdId);

    const res = await app.request(
      `/api/admin/users/${user!.id}/ledger`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: { kind: string; amountMcr: number; jobId: string | null; note: string | null }[];
    };
    expect(body.entries.map((e) => e.kind)).toEqual(["release", "hold", "allocation"]);
    expect(body.entries[0].amountMcr).toBe(700);
    expect(body.entries[1].amountMcr).toBe(-700);
    expect(body.entries[2].amountMcr).toBe(10_000);
  });

  it("404s for an unknown user id", async () => {
    const res = await app.request(
      "/api/admin/users/999999/ledger",
      { headers: { Authorization: `Bearer ${adminToken}` } },
      env
    );
    expect(res.status).toBe(404);
  });
});
