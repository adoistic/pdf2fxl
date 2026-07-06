import { describe, it, expect } from "vitest";
import { r2DirectEnabled, presignPut, presignGet } from "../src/presign";
import type { Env } from "../src/types";

// Dummy R2 credentials: the SigV4 signature is deterministic and testable without
// a real bucket. Structural checks confirm the presigned URL is well-formed.
const creds = {
  R2_ACCOUNT_ID: "acct123",
  R2_ACCESS_KEY_ID: "AKIAEXAMPLE",
  R2_SECRET_ACCESS_KEY: "secretexamplekey",
} as unknown as Env;

const noCreds = {} as unknown as Env;

describe("presign / r2DirectEnabled", () => {
  it("is disabled without all three secrets", () => {
    expect(r2DirectEnabled(noCreds)).toBe(false);
    expect(r2DirectEnabled({ R2_ACCOUNT_ID: "x" } as unknown as Env)).toBe(false);
    expect(r2DirectEnabled(creds)).toBe(true);
  });

  it("presigns a PUT to the R2 S3 endpoint with a signature and expiry", async () => {
    const url = await presignPut(creds, "uploads/5/abc.pdf", 900);
    const u = new URL(url);
    expect(u.host).toBe("acct123.r2.cloudflarestorage.com");
    expect(u.pathname).toBe("/thothica-ocr/uploads/5/abc.pdf");
    expect(u.searchParams.get("X-Amz-Signature")).toBeTruthy();
    expect(u.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(u.searchParams.get("X-Amz-Credential")).toContain("AKIAEXAMPLE");
    expect(u.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
  });

  it("presigns a GET and encodes key segments but keeps slashes", async () => {
    const url = await presignGet(creds, "doc/job 1/normalized.json", 60);
    const u = new URL(url);
    expect(u.pathname).toBe("/thothica-ocr/doc/job%201/normalized.json");
    expect(u.searchParams.get("X-Amz-Signature")).toBeTruthy();
  });

  it("different keys produce different signatures", async () => {
    const a = new URL(await presignPut(creds, "uploads/a.pdf", 300)).searchParams.get("X-Amz-Signature");
    const b = new URL(await presignPut(creds, "uploads/b.pdf", 300)).searchParams.get("X-Amz-Signature");
    expect(a).not.toBe(b);
  });
});
