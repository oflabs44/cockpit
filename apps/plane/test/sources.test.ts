import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { exportPKCS8, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { authedApp, authedRequest } from "./access";
import { db, sources } from "../src/db";
import type { Deps } from "../src/deps";
import type { Source } from "../src/schema";

// Module-level, never reset: D1 in this pool is shared across `it()` blocks (see
// enrolment.test.ts), so ids — and installation ids, unique per provider — must be unique
// across the whole file.
let idCounter = 0;
let installationCounter = 9_000;

function testDeps(nowMs = 1_700_000_000_000): Deps & { advance(ms: number): void } {
  let now = nowMs;
  return {
    clock: { now: () => now },
    ids: { id: (prefix) => `${prefix}_t${idCounter++}` },
    advance: (ms) => {
      now += ms;
    },
  };
}

function nextInstallationId(): number {
  return installationCounter++;
}

// wrangler.jsonc carries the real GITHUB_APP_* vars, and cloudflare:test's `env` inherits
// them. A test about an unconfigured plane must clear them rather than rely on their
// absence, or it passes for the wrong reason the moment deployment config changes.
function withoutGithubConfig(overrides: Record<string, string> = {}): typeof env {
  return {
    ...env,
    GITHUB_APP_ID: undefined,
    GITHUB_APP_SLUG: undefined,
    GITHUB_APP_PRIVATE_KEY: undefined,
    ...overrides,
  } as unknown as typeof env;
}

async function callback(
  app: ReturnType<typeof authedApp>,
  query: string,
  overrides: Record<string, string> = {},
) {
  return app.fetch(
    authedRequest(`http://plane.test/source-connections/github/callback?${query}`),
    withoutGithubConfig(overrides),
  );
}

describe("sources: github connect", () => {
  it("fails loudly when the GitHub app is not configured", async () => {
    const app = authedApp(testDeps());
    // content-type: json so `csrf()` doesn't treat the body-less POST as form-capable —
    // a browser's same-origin fetch passes via its Origin header instead.
    const res = await app.fetch(
      authedRequest("http://plane.test/source-connections/github/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
      withoutGithubConfig(),
    );
    expect(res.status).toBe(500);

    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("github app not configured");
    expect(body.error).toContain("GITHUB_APP_ID");
    expect(body.error).toContain("GITHUB_APP_SLUG");
    expect(body.error).toContain("GITHUB_APP_PRIVATE_KEY");
  });

  it("points at github.com when the app is fully configured", async () => {
    const app = authedApp(testDeps());
    const res = await app.fetch(
      authedRequest("http://plane.test/source-connections/github/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
      {
        ...env,
        GITHUB_APP_ID: "12345",
        GITHUB_APP_SLUG: "cockpit-test-app",
        GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----",
      },
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as { url: string; state: string };
    expect(body.url).toBe(
      `https://github.com/apps/cockpit-test-app/installations/select_target?state=${body.state}`,
    );
  });

  it("fails loudly on partial config instead of sending the operator through real GitHub", async () => {
    // Slug alone would produce a real github.com install URL whose callback could only be
    // mocked — a source that looks connected and is not. Must refuse up front.
    const app = authedApp(testDeps());
    const res = await app.fetch(
      authedRequest("http://plane.test/source-connections/github/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
      withoutGithubConfig({ GITHUB_APP_SLUG: "cockpit-test-app" }),
    );
    expect(res.status).toBe(500);

    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not configured");
    expect(body.error).toContain("GITHUB_APP_ID");
    expect(body.error).toContain("GITHUB_APP_PRIVATE_KEY");
    expect(body.error).not.toContain("GITHUB_APP_SLUG");
  });
});

// The callback is browser-navigated (GitHub sends the operator there), so it answers
// with a redirect back into the SPA, never JSON — facts are asserted against the DB.
describe("sources: github callback", () => {
  it("does not create a local mock source when config is absent", async () => {
    const app = authedApp(testDeps());
    const installationId = nextInstallationId();

    const res = await callback(app, `installation_id=${installationId}&setup_action=install`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/sources?error=github_app_misconfigured");

    const row = await db(env.DB)
      .select()
      .from(sources)
      .where(
        and(eq(sources.provider, "github"), eq(sources.installationId, installationId)),
      )
      .get();
    expect(row).toBeUndefined();
  });

  it("never stores facts under partial config — redirects with a misconfig hint", async () => {
    const app = authedApp(testDeps());
    const installationId = nextInstallationId();

    const res = await callback(app, `installation_id=${installationId}`, {
      GITHUB_APP_ID: "12345",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/sources?error=github_app_misconfigured");

    const row = await db(env.DB)
      .select()
      .from(sources)
      .where(
        and(eq(sources.provider, "github"), eq(sources.installationId, installationId)),
      )
      .get();
    expect(row).toBeUndefined();
  });

  it("rejects a callback without an installation_id", async () => {
    const res = await callback(authedApp(testDeps()), "setup_action=install");
    expect(res.status).toBe(400);
  });

  it("rejects an unknown setup_action", async () => {
    const res = await callback(
      authedApp(testDeps()),
      `installation_id=${nextInstallationId()}&setup_action=install_all`,
    );
    expect(res.status).toBe(400);
  });

  it("sends the operator back with a notice when the install awaits owner approval", async () => {
    // GitHub's request flow: the installer cannot install the app themselves, so the
    // callback arrives with setup_action=request and no installation id at all.
    const res = await callback(authedApp(testDeps()), "setup_action=request");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/sources?notice=pending-approval");
  });

  it("redirects with a generic code when the connect fails outside GitHub's own errors", async () => {
    const app = authedApp(testDeps());
    const installationId = nextInstallationId();

    // Config is complete, so nothing throws GitHubConfigError — but the key is PKCS#1,
    // which WebCrypto's importKey refuses before any request reaches github.com.
    const res = await callback(app, `installation_id=${installationId}`, {
      GITHUB_APP_ID: "12345",
      GITHUB_APP_SLUG: "cockpit-test-app",
      GITHUB_APP_PRIVATE_KEY:
        "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX\n-----END RSA PRIVATE KEY-----",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/sources?error=github_connect_failed");

    const row = await db(env.DB)
      .select()
      .from(sources)
      .where(and(eq(sources.provider, "github"), eq(sources.installationId, installationId)))
      .get();
    expect(row).toBeUndefined();
  });
});

describe("sources: list and detail", () => {
  it("lists a connected source and serves its detail", async () => {
    const app = authedApp(testDeps());
    const deps = testDeps();
    const installationId = nextInstallationId();
    const id = deps.ids.id("src");
    await db(env.DB).insert(sources).values({
      id,
      provider: "github",
      name: `fixture-account-${installationId}`,
      login: `fixture-account-${installationId}`,
      installationId,
      accountId: null,
      repositorySelection: "all",
      permissions: { contents: "read", metadata: "read" },
      events: ["push"],
      createdAt: deps.clock.now(),
      updatedAt: deps.clock.now(),
    });

    const list = await app.fetch(authedRequest("http://plane.test/source-connections"), env);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { sources: Source[] };
    const listed = listBody.sources.find((s) => s.id === id);
    expect(listed).toBeDefined();
    expect(listed!.github_installation_id).toBe(installationId);
    expect(listed!.github_login).toBe(`fixture-account-${installationId}`);

    const detail = await app.fetch(authedRequest(`http://plane.test/source-connections/${id}`), env);
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { source: Source }).source).toEqual(listed);
  });

  it("404s an unknown source id", async () => {
    const res = await authedApp(testDeps()).fetch(
      authedRequest("http://plane.test/source-connections/src_does_not_exist"),
      env,
    );
    expect(res.status).toBe(404);
  });
});

// --- disconnect ------------------------------------------------------------------------
// The GitHub call is the point of these tests, so `fetch` is replaced for the duration
// rather than the whole route being stubbed: the app JWT is really signed (against a key
// generated here) and really presented, and only api.github.com's answer is ours.

const { privateKey: appKey } = await generateKeyPair("RS256", { extractable: true });
const APP_PRIVATE_KEY_PEM = await exportPKCS8(appKey);

function withGithubConfig(overrides: Record<string, string> = {}): typeof env {
  return {
    ...env,
    GITHUB_APP_ID: "12345",
    GITHUB_APP_SLUG: "cockpit-test-app",
    GITHUB_APP_PRIVATE_KEY: APP_PRIVATE_KEY_PEM,
    ...overrides,
  } as unknown as typeof env;
}

type GithubCall = { url: string; method: string; authorization: string | null };

async function withGithubApi<T>(
  reply: (call: GithubCall) => Response,
  run: (calls: GithubCall[]) => Promise<T> | T,
): Promise<T> {
  const calls: GithubCall[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as RequestInfo, init);
    const call = {
      url: request.url,
      method: request.method,
      authorization: request.headers.get("authorization"),
    };
    calls.push(call);

    return reply(call);
  }) as typeof fetch;

  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

async function connectedSource(login = `disconnect-${installationCounter}`) {
  const deps = testDeps();
  const id = deps.ids.id("src");
  const installationId = nextInstallationId();

  await db(env.DB).insert(sources).values({
    id,
    provider: "github",
    name: login,
    login,
    installationId,
    accountId: null,
    repositorySelection: "all",
    permissions: { contents: "read", metadata: "read" },
    events: [],
    createdAt: deps.clock.now(),
    updatedAt: deps.clock.now(),
  });

  return { id, login, installationId };
}

function disconnect(
  app: ReturnType<typeof authedApp>,
  id: string,
  confirm: string,
  bindings: typeof env,
) {
  return app.fetch(
    authedRequest(`http://plane.test/source-connections/${id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm }),
    }),
    bindings,
  );
}

async function sourceRow(id: string) {
  return db(env.DB).select().from(sources).where(eq(sources.id, id)).get();
}

describe("sources: disconnect", () => {
  it("revokes on GitHub, then removes the connection", async () => {
    const app = authedApp(testDeps());
    const source = await connectedSource();

    const res = await withGithubApi(
      () => new Response(null, { status: 204 }),
      async (calls) => {
        const response = await disconnect(app, source.id, source.login, withGithubConfig());

        expect(calls).toHaveLength(1);
        expect(calls[0]?.method).toBe("DELETE");
        expect(calls[0]?.url).toBe(
          `https://api.github.com/app/installations/${source.installationId}`,
        );
        // As the app, not as an installation: a bearer JWT this plane signed.
        expect(calls[0]?.authorization).toMatch(/^Bearer eyJ/);

        return response;
      },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: source.id, revoked_on_github: true });
    expect(await sourceRow(source.id)).toBeUndefined();
  });

  it("treats a 404 from GitHub as already uninstalled and still removes the row", async () => {
    const app = authedApp(testDeps());
    const source = await connectedSource();

    const res = await withGithubApi(
      () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
      () => disconnect(app, source.id, source.login, withGithubConfig()),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: source.id, revoked_on_github: false });
    expect(await sourceRow(source.id)).toBeUndefined();
  });

  it("leaves the connection alone when GitHub fails for any other reason", async () => {
    const app = authedApp(testDeps());
    const source = await connectedSource();

    const res = await withGithubApi(
      () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }),
      () => disconnect(app, source.id, source.login, withGithubConfig()),
    );

    // Half-disconnected is the state that cannot be recovered from the UI.
    expect(res.status).toBe(502);
    expect(await sourceRow(source.id)).toBeDefined();
  });

  it("refuses without the confirmation, and never calls GitHub", async () => {
    const app = authedApp(testDeps());
    const source = await connectedSource();

    const wrong = await withGithubApi(
      () => new Response(null, { status: 204 }),
      async (calls) => {
        const response = await disconnect(app, source.id, "not-the-login", withGithubConfig());
        expect(calls).toHaveLength(0);

        return response;
      },
    );

    expect(wrong.status).toBe(400);
    expect(await sourceRow(source.id)).toBeDefined();

    const missing = await app.fetch(
      authedRequest(`http://plane.test/source-connections/${source.id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      withGithubConfig(),
    );
    expect(missing.status).toBe(400);
    expect(await sourceRow(source.id)).toBeDefined();
  });

  it("blames the plane, not GitHub, when the app key cannot be used", async () => {
    // GitHub hands out PKCS#1 and WebCrypto wants PKCS#8, so this is the easy mistake —
    // and it throws before any request leaves the Worker. Reporting it as "GitHub refused"
    // sends the operator to retry against a fault on this side.
    const app = authedApp(testDeps());
    const source = await connectedSource();

    const res = await withGithubApi(
      () => new Response(null, { status: 204 }),
      async (calls) => {
        const response = await disconnect(
          app,
          source.id,
          source.login,
          withGithubConfig({
            GITHUB_APP_PRIVATE_KEY:
              "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX\n-----END RSA PRIVATE KEY-----",
          }),
        );

        expect(calls).toHaveLength(0);

        return response;
      },
    );

    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("GITHUB_APP_PRIVATE_KEY");
    expect(await sourceRow(source.id)).toBeDefined();
  });

  it("fails loudly on an unconfigured plane, like the other GitHub routes", async () => {
    const app = authedApp(testDeps());
    const source = await connectedSource();

    const res = await disconnect(app, source.id, source.login, withoutGithubConfig());

    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("not configured");
    expect(await sourceRow(source.id)).toBeDefined();
  });

  it("accepts the confirmation in any case, since GitHub logins are case-insensitive", async () => {
    const app = authedApp(testDeps());
    const source = await connectedSource();

    const res = await withGithubApi(
      () => new Response(null, { status: 204 }),
      () => disconnect(app, source.id, source.login.toUpperCase(), withGithubConfig()),
    );

    expect(res.status).toBe(200);
    expect(await sourceRow(source.id)).toBeUndefined();
  });

  it("404s for a source that does not exist", async () => {
    const res = await disconnect(
      authedApp(testDeps()),
      "src_missing",
      "anything",
      withGithubConfig(),
    );

    expect(res.status).toBe(404);
  });

  it("requires authentication, like every operator route", async () => {
    const source = await connectedSource();

    const res = await authedApp().fetch(
      new Request(`http://plane.test/source-connections/${source.id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: source.login }),
      }),
      withGithubConfig(),
    );

    expect(res.status).toBe(401);
    expect(await sourceRow(source.id)).toBeDefined();
  });
});
