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

// Deliberate omission: no auth_time staleness or Firebase revocation check. Tokens live 1h; per-request revocation lookups need the Admin SDK and are not worth it for this product.
export async function verifyFirebaseToken(
  token: string,
  projectId: string
): Promise<FirebaseIdentity> {
  jwks ??= createRemoteJWKSet(new URL(JWKS_URL));
  const { payload } = await jwtVerify(token, jwks, {
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
    algorithms: ["RS256"],
  });
  if (!payload.sub || typeof payload.email !== "string") {
    throw new Error("token has no identity");
  }
  if (payload.email_verified !== true) {
    throw new Error("email not verified");
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
  const row = await upsertUser(c.env.DB, identity, seedAdmin);
  if (!row) {
    return c.json({ error: "account conflict, contact support" }, 409);
  }
  c.set("user", {
    id: row.id,
    uid: row.uid,
    email: row.email,
    name: row.name,
    isAdmin: row.is_admin === 1,
  });
  await next();
};

export const adminRequired: MiddlewareHandler<AppContext> = async (c, next) => {
  if (!c.get("user")?.isAdmin) {
    return c.json({ error: "not allowed" }, 403);
  }
  await next();
};

type UserRow = { id: number; uid: string; email: string; name: string | null; is_admin: number };

// Identity is keyed on the Firebase uid (stable); email is mutable metadata.
// Step 1 handles every returning user, including email changes in Firebase.
// Step 2 handles first sight of a uid: it claims a pre-allocated email row
// (admin can grant credits to an email before the person ever signs in) or
// creates a fresh row. email_verified has already been enforced, so linking
// by email cannot be hijacked via an unverified signup.
async function upsertUser(
  db: D1Database,
  identity: FirebaseIdentity,
  seedAdmin: number
): Promise<UserRow | null> {
  const update = () =>
    db
      .prepare(
        `UPDATE users SET email = ?2, name = COALESCE(?3, name), is_admin = MAX(is_admin, ?4)
         WHERE uid = ?1
         RETURNING id, uid, email, name, is_admin`
      )
      .bind(identity.uid, identity.email, identity.name, seedAdmin)
      .first<UserRow>();

  try {
    const updated = await update();
    if (updated) return updated;
    return await db
      .prepare(
        `INSERT INTO users (uid, email, name, is_admin) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(email) DO UPDATE SET
           uid = excluded.uid,
           name = COALESCE(excluded.name, users.name),
           is_admin = MAX(users.is_admin, excluded.is_admin)
         RETURNING id, uid, email, name, is_admin`
      )
      .bind(identity.uid, identity.email, identity.name, seedAdmin)
      .first<UserRow>();
  } catch (err) {
    if (String(err).includes("UNIQUE constraint failed: users.uid")) {
      // Lost a first-login race: another request inserted this uid between
      // our UPDATE miss and INSERT. The row exists now; update it.
      return update();
    }
    if (String(err).includes("UNIQUE constraint failed: users.email")) {
      // This uid's email changed in Firebase to an address another row owns.
      // Rare enough that a clean conflict beats silent merging.
      return null;
    }
    throw err;
  }
}
