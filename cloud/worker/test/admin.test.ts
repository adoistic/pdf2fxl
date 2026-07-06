import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, it, expect } from "vitest";
import app from "../src/index";
import { makeFirebaseMock, type FirebaseMock } from "./firebase-mock";

let fb: FirebaseMock;
let adminToken: string;
let userToken: string;

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
  adminToken = await fb.tokenFor({ sub: "uid-adnan", email: "adnan@thothica.com", name: "Adnan" });
  userToken = await fb.tokenFor({ sub: "uid-plain", email: "plain@test.dev" });
});

function post(path: string, token: string, body: unknown) {
  return app.request(
    path,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env
  );
}

describe("admin credits", () => {
  it("non-admin cannot allocate", async () => {
    const res = await post("/api/admin/credits", userToken, {
      email: "x@test.dev",
      credits: 10,
    });
    expect(res.status).toBe(403);
  });

  it("admin allocates to a brand new email (user created on the spot)", async () => {
    const res = await post("/api/admin/credits", adminToken, {
      email: "NewClient@test.dev",
      credits: 250,
      note: "pilot batch",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "newclient@test.dev", balanceMcr: 250_000, balance: 250 });
  });

  it("fractional credits allocate exactly in milli-credits", async () => {
    const res = await post("/api/admin/credits", adminToken, {
      email: "frac@test.dev",
      credits: 0.7,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "frac@test.dev", balanceMcr: 700, balance: 0.7 });
  });

  it("rejects garbage requests", async () => {
    for (const bad of [
      { email: "no-at-sign", credits: 10 },
      { email: "a@test.dev", credits: 0 },
      { email: "a@test.dev", credits: Number.NaN },
      { email: "a@test.dev" },
      {},
    ]) {
      const res = await post("/api/admin/credits", adminToken, bad);
      expect(res.status).toBe(400);
    }
  });

  it("lists users with balances", async () => {
    await post("/api/admin/credits", adminToken, { email: "listme@test.dev", credits: 42 });
    const res = await app.request(
      "/api/admin/users",
      { headers: { Authorization: `Bearer ${adminToken}` } },
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: { email: string; balance: number }[] };
    const target = body.users.find((u) => u.email === "listme@test.dev");
    expect(target?.balance).toBe(42);
  });
});
