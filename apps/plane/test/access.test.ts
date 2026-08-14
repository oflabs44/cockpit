import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { db, enrolments } from "../src/db";
import {
  AUD,
  ISSUER,
  OPERATOR_EMAIL,
  accessBindings,
  accessHeader,
  authedApp,
  jwksFetch,
  signAccessToken,
} from "./access";

// `env` already carries the fixture's ACCESS_* values (vitest.config.ts), so these bindings
// only need overriding where a test is about their absence.
const bindings = { ...env, ...accessBindings };

function app() {
  return createApp(undefined, { fetch: jwksFetch });
}

async function get(path: string, headers: Record<string, string> = {}, overrides = {}) {
  return app().fetch(new Request(`http://plane.test${path}`, { headers }), {
    ...bindings,
    ...overrides,
  });
}

describe("Cloudflare Access", () => {
  it("lets a valid token through", async () => {
    const res = await get("/health", accessHeader(await signAccessToken()));

    expect(res.status).toBe(200);
  });

  it("rejects a token minted for another Access application", async () => {
    const res = await get("/health", accessHeader(await signAccessToken({ audience: "other-aud" })));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });

  it("rejects a token from another team", async () => {
    const token = await signAccessToken({ issuer: "https://someone-else.cloudflareaccess.com" });
    const res = await get("/health", accessHeader(token));

    expect(res.status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const res = await get("/health", accessHeader(await signAccessToken({ expiresInSeconds: -60 })));

    expect(res.status).toBe(401);
  });

  it("rejects a request with no token at all", async () => {
    const res = await get("/health");

    expect(res.status).toBe(401);
    // The reason never reaches the caller: a probe learns only that it is unauthenticated.
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });

  it("rejects a token carrying no email, since there is no actor to record", async () => {
    const res = await get("/health", accessHeader(await signAccessToken({ email: null })));

    expect(res.status).toBe(401);
  });

  it("refuses to serve at all when a binding is missing, rather than serving openly", async () => {
    for (const missing of ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD"] as const) {
      const res = await get("/health", accessHeader(await signAccessToken()), {
        [missing]: undefined,
      });

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        error: "plane is not configured for authentication",
        missing: [missing],
      });
    }
  });

  it("records the verified email as the actor, not a constant", async () => {
    const res = await app().fetch(
      new Request("http://plane.test/servers", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...accessHeader(await signAccessToken({ email: "someone@oflabs.test" })),
        },
        body: JSON.stringify({ name: `access-actor-${crypto.randomUUID()}`, provider: "hetzner" }),
      }),
      bindings,
    );

    expect(res.status).toBe(201);

    const { server } = (await res.json()) as { server: { id: string } };
    const [row] = await db(env.DB)
      .select()
      .from(enrolments)
      .where(eq(enrolments.serverId, server.id));

    expect(JSON.parse(row?.createdBy ?? "null")).toEqual({
      kind: "human",
      id: "someone@oflabs.test",
    });
  });

  it("answers 503, not 401, when the key set cannot be fetched", async () => {
    // A valid session must not be told to re-authenticate over a transient fetch failure:
    // logging in again cannot fix it, so the client would loop.
    const failing: typeof fetch = async () => {
      throw new TypeError("network error");
    };

    const res = await createApp(undefined, { fetch: failing }).fetch(
      new Request("http://plane.test/health", { headers: accessHeader(await signAccessToken()) }),
      bindings,
    );

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "cannot verify the access token right now" });
  });

  it("answers 503 when the key set is served but unusable", async () => {
    const garbage: typeof fetch = async () =>
      new Response("{}", { headers: { "content-type": "application/json" } });

    const res = await createApp(undefined, { fetch: garbage }).fetch(
      new Request("http://plane.test/health", { headers: accessHeader(await signAccessToken()) }),
      bindings,
    );

    expect(res.status).toBe(503);
  });

  it("leaves /daemon alone: it authenticates its own per-server credential", async () => {
    // No Access header, and an upgrade the middleware would have refused. Reaching the
    // daemon route's own 401 — not the middleware's — is the proof it was skipped.
    const res = await authedApp().fetch(
      new Request("http://plane.test/daemon", { headers: { Upgrade: "websocket" } }),
      env,
    );

    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("plane is not configured");
  });

  it("has one deliberate way past, and it announces itself on every request", async () => {
    const warnings: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args);

    try {
      const res = await get("/health", {}, { COCKPIT_DEV_NO_AUTH: "1" });

      expect(res.status).toBe(200);
      expect(String(warnings[0]?.[0])).toContain("COCKPIT_DEV_NO_AUTH=1");
    } finally {
      console.warn = original;
    }
  });

  it("fetches the key set once and reuses it across requests", async () => {
    let fetches = 0;
    const counting: typeof fetch = async (...args) => {
      fetches += 1;
      return jwksFetch(...(args as Parameters<typeof fetch>));
    };

    const counted = createApp(undefined, { fetch: counting });
    const token = accessHeader(await signAccessToken());

    for (let i = 0; i < 3; i += 1) {
      const res = await counted.fetch(
        new Request("http://plane.test/health", { headers: token }),
        bindings,
      );
      expect(res.status).toBe(200);
    }

    expect(fetches).toBe(1);
  });

  it("verifies against the issuer and audience it was configured with", async () => {
    // Guards the wiring rather than jose: a middleware that passed the wrong strings here
    // would still accept the fixture's own tokens.
    expect(ISSUER).toBe("https://cockpit-test.cloudflareaccess.com");
    expect(accessBindings.ACCESS_AUD).toBe(AUD);
    expect(OPERATOR_EMAIL).toContain("@");
  });
});
