// Cloudflare Access sits in front of the plane and this verifies what it issued. Access
// terminating the login is not by itself authentication for the Worker: anything that can
// reach the Worker's origin bypasses the edge check, so the JWT is verified here.

import { createRemoteJWKSet, jwtVerify, customFetch } from "jose";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./app";

/** Who the request is from, once Access has been verified. */
export type Identity = { email: string; sub: string };

/** The header Access sets. The CF_Authorization cookie is not guaranteed to be forwarded. */
const ACCESS_HEADER = "Cf-Access-Jwt-Assertion";

export type AccessOptions = {
  /**
   * Injected by tests to serve the JWKS without a network fetch. jose calls this exactly
   * where it would call global fetch, so the remote key set, its cache and the verification
   * are all still the real ones.
   */
  fetch?: typeof fetch;
};

/**
 * `<team>.cloudflareaccess.com`, however the operator wrote it in wrangler.jsonc. Both the
 * issuer claim and the certs URL are derived from this one value, so they cannot drift.
 */
function teamOrigin(teamDomain: string): string {
  const bare = teamDomain.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `https://${bare}`;
}

/**
 * Whether the token is what was wrong, as opposed to this plane being unable to check it.
 * Listed rather than excluded, so an error nobody anticipated is treated as "cannot verify"
 * (503) rather than silently reported to the operator as a bad login.
 */
const TOKEN_FAULTS = new Set([
  "ERR_JWT_EXPIRED",
  "ERR_JWT_INVALID",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWS_INVALID",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JOSE_ALG_NOT_ALLOWED",
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JWKS_MULTIPLE_MATCHING_KEYS",
]);

function isTokenFault(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "string" && TOKEN_FAULTS.has(code);
}

export function accessAuth(options: AccessOptions = {}): MiddlewareHandler<AppEnv> {
  // Per app rather than per request: createRemoteJWKSet caches the fetched keys inside the
  // returned function, so building a new one each request would fetch the certs each request.
  const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

  const keySetFor = (origin: string) => {
    let set = keySets.get(origin);
    if (!set) {
      set = createRemoteJWKSet(new URL(`${origin}/cdn-cgi/access/certs`), {
        ...(options.fetch ? { [customFetch]: options.fetch } : {}),
      });
      keySets.set(origin, set);
    }
    return set;
  };

  return async (c, next) => {
    // The one way past this check, and it has to be set on purpose. `wrangler dev` has no
    // Access in front of it, so without an escape the plane cannot be run locally at all.
    if (c.env?.COCKPIT_DEV_NO_AUTH === "1") {
      // Every request, deliberately: a plane that has been left in this mode should be
      // impossible to miss in the logs rather than quietly open.
      console.warn(
        `COCKPIT_DEV_NO_AUTH=1: serving ${c.req.method} ${c.req.path} with NO authentication. ` +
          `This must never be set on a deployed plane.`,
      );
      c.set("identity", { email: "dev@localhost", sub: "dev" });
      return next();
    }

    // Fail closed. A plane missing its Access configuration is unusable, not unauthenticated:
    // the alternative is a Worker that silently serves operator routes to anyone.
    const missing: string[] = [];
    if (!c.env?.ACCESS_TEAM_DOMAIN) missing.push("ACCESS_TEAM_DOMAIN");
    if (!c.env?.ACCESS_AUD) missing.push("ACCESS_AUD");

    if (missing.length > 0) {
      return c.json(
        {
          error: "plane is not configured for authentication",
          missing,
        },
        503,
      );
    }

    const token = c.req.header(ACCESS_HEADER);
    if (!token) return c.json({ error: "unauthenticated" }, 401);

    const origin = teamOrigin(c.env.ACCESS_TEAM_DOMAIN as string);

    let payload: Record<string, unknown>;
    try {
      // Issuer, audience and expiry are all checked by jwtVerify: `exp` always, the other two
      // because they are passed here. A token minted for another Access application, or by
      // another team, is signed by a key this key set will not produce.
      const verified = await jwtVerify(token, keySetFor(origin), {
        issuer: origin,
        audience: c.env.ACCESS_AUD as string,
      });
      payload = verified.payload as Record<string, unknown>;
    } catch (err) {
      // Only the caller's own fault is a 401. Failing to fetch the key set — a cold isolate,
      // a DNS blip, an Access outage — is this plane being unable to verify anything, and
      // answering 401 to a valid session sends the client off to re-authenticate in a loop
      // that cannot fix it.
      if (!isTokenFault(err)) {
        console.error("cannot verify access tokens", { path: c.req.path, error: String(err) });
        return c.json({ error: "cannot verify the access token right now" }, 503);
      }

      // Logged, not returned: the caller learns only that they are unauthenticated, while
      // the operator can still tell an expired token from a misconfigured AUD.
      console.warn("access token rejected", { path: c.req.path, error: String(err) });
      return c.json({ error: "unauthenticated" }, 401);
    }

    const email = typeof payload.email === "string" ? payload.email : "";
    const sub = typeof payload.sub === "string" ? payload.sub : "";

    // A service token has no email. Those are for machines, and every operator route records
    // a human actor, so there is nothing sensible to attribute the change to.
    if (!email) {
      console.warn("access token carried no email claim", { path: c.req.path, sub });
      return c.json({ error: "unauthenticated" }, 401);
    }

    c.set("identity", { email, sub });

    return next();
  };
}
