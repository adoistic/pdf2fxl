import { AwsClient } from "aws4fetch";
import type { Env } from "./types";

// R2-direct presigned URLs. When the three R2 secrets are set, the Worker mints
// short-lived S3 URLs so bytes flow client <-> R2 <-> container directly, never
// through the Worker. Until then r2DirectEnabled() is false and the app uses the
// streaming fallback (bytes transit the Worker but are never buffered).
//
// Set with:
//   wrangler secret put R2_ACCOUNT_ID
//   wrangler secret put R2_ACCESS_KEY_ID
//   wrangler secret put R2_SECRET_ACCESS_KEY
// from an R2 API token (dashboard: R2 -> Manage R2 API Tokens -> Object Read & Write).

const BUCKET = "thothica-ocr";

export function r2DirectEnabled(env: Env): boolean {
  return Boolean(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY);
}

function endpoint(env: Env, key: string): string {
  return `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${BUCKET}/${encodeR2Key(key)}`;
}

// Encode each path segment but keep the slashes that structure the key.
function encodeR2Key(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function client(env: Env): AwsClient {
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID!,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    service: "s3",
    region: "auto",
  });
}

async function presign(env: Env, key: string, method: "PUT" | "GET", expiresSec: number): Promise<string> {
  const url = `${endpoint(env, key)}?X-Amz-Expires=${expiresSec}`;
  const signed = await client(env).sign(url, { method, aws: { signQuery: true } });
  return signed.url;
}

// A URL the browser (upload) or container (read/write) uses to reach R2 directly.
export function presignPut(env: Env, key: string, expiresSec = 3600): Promise<string> {
  return presign(env, key, "PUT", expiresSec);
}

export function presignGet(env: Env, key: string, expiresSec = 3600): Promise<string> {
  return presign(env, key, "GET", expiresSec);
}
