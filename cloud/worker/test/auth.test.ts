import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, it, expect } from "vitest";
import { app } from "../src/index";
import { makeFirebaseMock, type FirebaseMock } from "./firebase-mock";

let fb: FirebaseMock;

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
});

async function me(token?: string) {
  return app.request(
    "/api/me",
    { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    env
  );
}

describe("auth", () => {
  it("rejects requests without a token", async () => {
    const res = await me();
    expect(res.status).toBe(401);
  });

  it("rejects tokens signed by the wrong key", async () => {
    const res = await me(await fb.foreignTokenFor({ sub: "u1", email: "evil@test.dev" }));
    expect(res.status).toBe(401);
  });

  it("rejects tokens for a different Firebase project", async () => {
    const res = await me(
      await fb.tokenFor({ sub: "u1", email: "a@test.dev" }, { audience: "other-project" })
    );
    expect(res.status).toBe(401);
  });

  it("rejects expired tokens", async () => {
    const res = await me(
      await fb.tokenFor(
        { sub: "u1", email: "a@test.dev" },
        { expiresAt: Math.floor(Date.now() / 1000) - 60 }
      )
    );
    expect(res.status).toBe(401);
  });

  it("accepts a valid token, creates the user, returns zero balance", async () => {
    const res = await me(await fb.tokenFor({ sub: "uid-alpha", email: "Alpha@Test.dev", name: "Alpha" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      email: string; name: string | null; isAdmin: boolean; balance: number; balanceMcr: number;
    };
    expect(body).toEqual({
      email: "alpha@test.dev",
      name: "Alpha",
      isAdmin: false,
      balance: 0,
      balanceMcr: 0,
      // hidden add-ons: null unless the admin flips the user's flags
      translate: null,
      branding: null,
    });
  });

  it("links the Firebase uid to a pre-created email row instead of duplicating", async () => {
    await env.DB.prepare("INSERT INTO users (email) VALUES ('pre@test.dev')").run();
    const res = await me(await fb.tokenFor({ sub: "uid-pre", email: "pre@test.dev" }));
    expect(res.status).toBe(200);
    const { results } = await env.DB.prepare(
      "SELECT uid FROM users WHERE email = 'pre@test.dev'"
    ).all<{ uid: string | null }>();
    expect(results).toHaveLength(1);
    expect(results[0].uid).toBe("uid-pre");
  });

  it("grants admin to the configured admin email", async () => {
    const res = await me(await fb.tokenFor({ sub: "uid-adnan", email: "adnan@thothica.com" }));
    const body = (await res.json()) as { isAdmin: boolean };
    expect(body.isAdmin).toBe(true);
  });

  it("rejects tokens whose email is not verified", async () => {
    const res = await me(
      await fb.tokenFor(
        { sub: "uid-unv", email: "adnan@thothica.com" },
        { emailVerified: false }
      )
    );
    expect(res.status).toBe(401);
    const row = await env.DB.prepare(
      "SELECT is_admin FROM users WHERE uid = 'uid-unv'"
    ).first();
    expect(row).toBeNull();
  });

  it("rejects tokens missing the email_verified claim", async () => {
    const res = await me(
      await fb.tokenFor(
        { sub: "uid-unv2", email: "someone@test.dev" },
        { emailVerified: "omit" }
      )
    );
    expect(res.status).toBe(401);
  });

  it("follows an email change in Firebase without duplicating or crashing", async () => {
    let res = await me(await fb.tokenFor({ sub: "uid-mover", email: "old@test.dev" }));
    expect(res.status).toBe(200);
    res = await me(await fb.tokenFor({ sub: "uid-mover", email: "new@test.dev" }));
    expect(res.status).toBe(200);
    const { results } = await env.DB.prepare(
      "SELECT email FROM users WHERE uid = 'uid-mover'"
    ).all<{ email: string }>();
    expect(results).toHaveLength(1);
    expect(results[0].email).toBe("new@test.dev");
    const old = await env.DB.prepare(
      "SELECT id FROM users WHERE email = 'old@test.dev'"
    ).first();
    expect(old).toBeNull();
  });

  it("rejects non-Bearer authorization schemes", async () => {
    const res = await app.request(
      "/api/me",
      { headers: { Authorization: "Basic dXNlcjpwYXNz" } },
      env
    );
    expect(res.status).toBe(401);
  });

  it("never relinks a row owned by another uid, even for a verified email", async () => {
    // Y signs in and owns the row for shared@test.dev
    let res = await me(await fb.tokenFor({ sub: "uid-owner-y", email: "shared@test.dev" }));
    expect(res.status).toBe(200);
    // X arrives with a verified token for the same email (recycled mailbox)
    res = await me(await fb.tokenFor({ sub: "uid-newcomer-x", email: "shared@test.dev" }));
    expect(res.status).toBe(409);
    // Y's row is untouched
    const row = await env.DB.prepare(
      "SELECT uid FROM users WHERE email = 'shared@test.dev'"
    ).first<{ uid: string }>();
    expect(row!.uid).toBe("uid-owner-y");
  });
});
