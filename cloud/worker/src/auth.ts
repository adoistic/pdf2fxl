import { createRemoteJWKSet, jwtVerify } from "jose";
import type { MiddlewareHandler } from "hono";
import type { AppUser, Env } from "./types";

const JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

export interface FirebaseIdentity {
  uid: string;
  email: string;
  name: string | null;
}

export async function verifyFirebaseToken(
  token: string,
  projectId: string
): Promise<FirebaseIdentity> {
  jwks ??= createRemoteJWKSet(new URL(JWKS_URL));
  const { payload } = await jwtVerify(token, jwks, {
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
  });
  if (!payload.sub || typeof payload.email !== "string") {
    throw new Error("token has no identity");
  }
  return {
    uid: payload.sub,
    email: payload.email.toLowerCase(),
    name: typeof payload.name === "string" ? payload.name : null,
  };
}

type AppContext = { Bindings: Env; Variables: { user: AppUser } };

export const authRequired: MiddlewareHandler<AppContext> = async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "sign in required" }, 401);
  }
  let identity: FirebaseIdentity;
  try {
    identity = await verifyFirebaseToken(header.slice(7), c.env.FIREBASE_PROJECT_ID);
  } catch {
    return c.json({ error: "sign in required" }, 401);
  }
  const seedAdmin = identity.email === c.env.ADMIN_EMAIL.toLowerCase() ? 1 : 0;
  const row = await c.env.DB.prepare(
    `INSERT INTO users (uid, email, name, is_admin) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(email) DO UPDATE SET
       uid = excluded.uid,
       name = COALESCE(excluded.name, users.name),
       is_admin = MAX(users.is_admin, excluded.is_admin)
     RETURNING id, uid, email, name, is_admin`
  )
    .bind(identity.uid, identity.email, identity.name, seedAdmin)
    .first<{ id: number; uid: string; email: string; name: string | null; is_admin: number }>();
  c.set("user", {
    id: row!.id,
    uid: row!.uid,
    email: row!.email,
    name: row!.name,
    isAdmin: row!.is_admin === 1,
  });
  await next();
};

export const adminRequired: MiddlewareHandler<AppContext> = async (c, next) => {
  if (!c.get("user")?.isAdmin) {
    return c.json({ error: "not allowed" }, 403);
  }
  await next();
};
