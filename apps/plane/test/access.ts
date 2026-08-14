// Access fixtures. The tokens here are real RS256 JWTs signed by a key pair generated for
// this run, and they are verified through the same createRemoteJWKSet + jwtVerify path
// production uses — only the HTTP fetch of the key set is replaced, by jose's own
// `customFetch` hook, so nothing about the verification is stubbed.

import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { createApp } from "../src/app";
import type { Deps } from "../src/deps";

export const TEAM_DOMAIN = "cockpit-test.cloudflareaccess.com";
export const ISSUER = `https://${TEAM_DOMAIN}`;
export const AUD = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
export const OPERATOR_EMAIL = "operator@oflabs.test";

export const accessBindings = {
  ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  ACCESS_AUD: AUD,
};

const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });

const jwks = {
  keys: [{ ...(await exportJWK(publicKey)), kid: "cockpit-test-key", alg: "RS256", use: "sig" }],
};

/** Stands in for `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`. */
export const jwksFetch: typeof fetch = async () =>
  new Response(JSON.stringify(jwks), { headers: { "content-type": "application/json" } });

export type TokenOptions = {
  issuer?: string;
  audience?: string;
  email?: string | null;
  /** Seconds relative to now; negative mints an already-expired token. */
  expiresInSeconds?: number;
};

export async function signAccessToken(options: TokenOptions = {}): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const email = options.email === null ? undefined : (options.email ?? OPERATOR_EMAIL);

  return new SignJWT({ ...(email ? { email } : {}) })
    .setProtectedHeader({ alg: "RS256", kid: "cockpit-test-key" })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUD)
    .setSubject("test-subject")
    .setIssuedAt(nowSeconds - 60)
    .setExpirationTime(nowSeconds + (options.expiresInSeconds ?? 3600))
    .sign(privateKey);
}

const validToken = await signAccessToken();

/** An app whose Access middleware reads the fixture key set instead of the network. */
export function authedApp(deps?: Deps) {
  return createApp(deps, { fetch: jwksFetch });
}

/**
 * A Request carrying a valid Access token. `/daemon` ignores the header — it is excluded
 * from the middleware — so tests can build every request the same way.
 */
export function authedRequest(input: RequestInfo | URL, init?: RequestInit): Request {
  const request = new Request(input as RequestInfo, init);
  request.headers.set("Cf-Access-Jwt-Assertion", validToken);

  return request;
}

export function accessHeader(token: string): Record<string, string> {
  return { "Cf-Access-Jwt-Assertion": token };
}
