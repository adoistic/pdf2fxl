// Generates a real RSA keypair, serves its public JWK through fetchMock at
// Google's JWKS URL, and signs Firebase-shaped ID tokens with the private key.
// Auth tests therefore exercise genuine RS256 verification, not a stub.
import { exportJWK, generateKeyPair, SignJWT } from "jose";

export interface FirebaseMock {
  jwks: { keys: Record<string, unknown>[] };
  tokenFor(
    claims: { sub: string; email: string; name?: string },
    overrides?: { issuer?: string; audience?: string; expiresAt?: number }
  ): Promise<string>;
  foreignTokenFor(claims: { sub: string; email: string }): Promise<string>;
}

export async function makeFirebaseMock(projectId: string): Promise<FirebaseMock> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const foreign = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };

  async function sign(
    key: CryptoKey,
    kid: string,
    claims: { sub: string; email: string; name?: string },
    overrides: { issuer?: string; audience?: string; expiresAt?: number } = {}
  ) {
    return new SignJWT({ email: claims.email, ...(claims.name ? { name: claims.name } : {}) })
      .setProtectedHeader({ alg: "RS256", kid })
      .setSubject(claims.sub)
      .setIssuer(overrides.issuer ?? `https://securetoken.google.com/${projectId}`)
      .setAudience(overrides.audience ?? projectId)
      .setIssuedAt()
      .setExpirationTime(overrides.expiresAt ?? Math.floor(Date.now() / 1000) + 3600)
      .sign(key);
  }

  return {
    jwks: { keys: [jwk] },
    tokenFor: (claims, overrides) => sign(privateKey, "test-key", claims, overrides),
    foreignTokenFor: (claims) => sign(foreign.privateKey, "test-key", claims),
  };
}
