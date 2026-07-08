import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, it, expect } from "vitest";
import { app } from "../src/index";
import { makeFirebaseMock, type FirebaseMock } from "./firebase-mock";

let fb: FirebaseMock;
let token: string;
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
  token = await fb.tokenFor({ sub: "uid-br", email: "br@test.dev" });
  adminToken = await fb.tokenFor({ sub: "uid-br-admin", email: "adnan@thothica.com" });
});

function req(path: string, tok: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${tok}`);
  return app.request(path, { ...init, headers }, env);
}

// Signs the user in once (creates the row) and flips their branding flag on.
async function enableBranding() {
  await req("/api/me", token);
  await env.DB.prepare("UPDATE users SET branding_enabled = 1 WHERE email = 'br@test.dev'").run();
}

const DEFAULTS = {
  brandColor: null, accentColor: null, backgroundColor: null,
  font: null, hasLogo: false, logoType: null,
};

describe("branding gate", () => {
  it("every /api/branding route is 404 without the flag", async () => {
    await req("/api/me", token);
    expect((await req("/api/branding", token)).status).toBe(404);
    expect((await req("/api/branding/logo", token)).status).toBe(404);
    expect(
      (await req("/api/branding", token, { method: "PUT", body: "{}" })).status
    ).toBe(404);
  });

  it("/api/me carries branding only when flagged", async () => {
    await req("/api/me", token);
    let body = (await (await req("/api/me", token)).json()) as { branding: unknown };
    expect(body.branding).toBeNull();
    await enableBranding();
    body = (await (await req("/api/me", token)).json()) as { branding: unknown };
    expect(body.branding).toEqual(DEFAULTS);
  });
});

describe("branding settings", () => {
  it("saves and returns colors and font; null clears a field", async () => {
    await enableBranding();
    const put = await req("/api/branding", token, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        brandColor: "#1a2b3c", backgroundColor: "#FAFAF0", font: "playfair-inter",
      }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({
      ...DEFAULTS, brandColor: "#1a2b3c", backgroundColor: "#FAFAF0",
      font: "playfair-inter",
    });
    // patch one field, clear another
    const patch = await req("/api/branding", token, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accentColor: "#c0ffee", backgroundColor: null }),
    });
    expect(await patch.json()).toEqual({
      ...DEFAULTS, brandColor: "#1a2b3c", accentColor: "#c0ffee",
      font: "playfair-inter",
    });
  });

  it("rejects junk colors and unknown fonts", async () => {
    await enableBranding();
    for (const body of [
      { brandColor: "red" },
      { brandColor: "#12345" },
      { brandColor: "#12345g" },
      { font: "comic-sans" },
      { backgroundColor: "url(javascript:1)" },
    ]) {
      const res = await req("/api/branding", token, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });

  it("reset returns the standard look and deletes the logo object", async () => {
    await enableBranding();
    await req("/api/branding", token, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ brandColor: "#1a2b3c" }),
    });
    await req("/api/branding/logo", token, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: new Uint8Array([137, 80, 78, 71]),
    });
    const res = await req("/api/branding", token, { method: "DELETE" });
    expect(await res.json()).toEqual(DEFAULTS);
    const userRow = await env.DB.prepare(
      "SELECT id FROM users WHERE email = 'br@test.dev'"
    ).first<{ id: number }>();
    expect(await env.STORE.get(`branding/${userRow!.id}/logo`)).toBeNull();
  });
});

describe("logo upload", () => {
  it("stores and streams the logo back with its content type", async () => {
    await enableBranding();
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const up = await req("/api/branding/logo", token, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: png,
    });
    expect(up.status).toBe(200);
    expect(((await up.json()) as { hasLogo: boolean }).hasLogo).toBe(true);

    const got = await req("/api/branding/logo", token);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(png);

    const del = await req("/api/branding/logo", token, { method: "DELETE" });
    expect(((await del.json()) as { hasLogo: boolean }).hasLogo).toBe(false);
    expect((await req("/api/branding/logo", token)).status).toBe(404);
  });

  it("rejects svg, wrong types, and oversized files", async () => {
    await enableBranding();
    const svg = await req("/api/branding/logo", token, {
      method: "POST",
      headers: { "content-type": "image/svg+xml" },
      body: "<svg/>",
    });
    expect(svg.status).toBe(415);
    const big = await req("/api/branding/logo", token, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: new Uint8Array(1024 * 1024 + 1),
    });
    expect(big.status).toBe(413);
    const empty = await req("/api/branding/logo", token, {
      method: "POST",
      headers: { "content-type": "image/png" },
    });
    expect(empty.status).toBe(400);
  });
});

describe("admin flag", () => {
  it("flips branding by email and the users list shows it", async () => {
    const res = await req("/api/admin/users/branding", adminToken, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "brandable@test.dev", enabled: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "brandable@test.dev", brandingEnabled: true });
    const list = await req("/api/admin/users", adminToken);
    const body = (await list.json()) as { users: { email: string; brandingEnabled: boolean }[] };
    expect(body.users.find((u) => u.email === "brandable@test.dev")?.brandingEnabled).toBe(true);
  });

  it("non-admins cannot flip it", async () => {
    const res = await req("/api/admin/users/branding", token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "x@test.dev", enabled: true }),
    });
    expect(res.status).toBe(403);
  });
});
