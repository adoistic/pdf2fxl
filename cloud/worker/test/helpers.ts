import { env } from "cloudflare:test";

let seq = 0;

export async function createUser(email?: string): Promise<number> {
  const addr = email ?? `user${++seq}-${crypto.randomUUID().slice(0, 8)}@test.dev`;
  const row = await env.DB.prepare("INSERT INTO users (email) VALUES (?1) RETURNING id")
    .bind(addr)
    .first<{ id: number }>();
  return row!.id;
}
