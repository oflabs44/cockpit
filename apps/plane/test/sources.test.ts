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

// --- repositories ----------------------------------------------------------------------
// ADR-0012. Each request mints, spends, then revokes an installation token.

const INSTALLATION_TOKEN = "ghs_test_installation_token_do_not_leak";

function githubRepository(id: number, fullName: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    full_name: fullName,
    default_branch: "main",
    private: false,
    archived: false,
    // Everything else GitHub sends and cockpit must not pass through.
    clone_url: `https://github.com/${fullName}.git`,
    owner: { login: fullName.split("/")[0] },
    ...overrides,
  };
}

/** What GitHub answers a listing request with: one page, and the size of the whole grant. */
function repositoryListing(repositories: unknown[], totalCount = repositories.length) {
  return new Response(JSON.stringify({ total_count: totalCount, repositories }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Answers the token exchange, then hands the listing request to `listing`. */
function githubRepositoryApi(listing: (call: GithubCall) => Response) {
  return (call: GithubCall) => {
    if (call.url.endsWith("/access_tokens")) {
      return new Response(
        JSON.stringify({ token: INSTALLATION_TOKEN, expires_at: "2023-11-14T22:13:20Z" }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    if (call.url.endsWith("/installation/token")) {
      return new Response(null, { status: 204 });
    }

    return listing(call);
  };
}

function listRepositories(
  app: ReturnType<typeof authedApp>,
  id: string,
  query: string,
  bindings: typeof env,
) {
  const suffix = query ? `?${query}` : "";

  return app.fetch(
    authedRequest(`http://plane.test/source-connections/${id}/repositories${suffix}`),
    bindings,
  );
}

type RepositoryListBody = {
  repositories: { id: string; full_name: string; default_branch: string; private: boolean; archived: boolean }[];
  page: number;
  per_page: number;
  total_count: number;
  has_more: boolean;
};

describe("sources: repositories", () => {
  it("exchanges the app JWT for an installation token, then lists what the grant covers", async () => {
    const app = authedApp(testDeps());
    const source = await connectedSource();

    const res = await withGithubApi(
      githubRepositoryApi(() =>
        repositoryListing([
          githubRepository(4_567, "oflabs44/cockpit", { private: true }),
          githubRepository(89, "oflabs44/retired", { archived: true, default_branch: "trunk" }),
        ]),
      ),
      async (calls) => {
        const response = await listRepositories(app, source.id, "", withGithubConfig());

        expect(calls).toHaveLength(3);
        // As the app, to mint the token...
        expect(calls[0]?.method).toBe("POST");
        expect(calls[0]?.url).toBe(
          `https://api.github.com/app/installations/${source.installationId}/access_tokens`,
        );
        expect(calls[0]?.authorization).toMatch(/^Bearer eyJ/);
        // ...then as the installation, which is the only identity that can see repositories.
        expect(calls[1]?.method).toBe("GET");
        expect(calls[1]?.url).toBe(
          "https://api.github.com/installation/repositories?per_page=100&page=1",
        );
        expect(calls[1]?.authorization).toBe(`Bearer ${INSTALLATION_TOKEN}`);
        expect(calls[2]).toEqual({
          method: "DELETE",
          url: "https://api.github.com/installation/token",
          authorization: `Bearer ${INSTALLATION_TOKEN}`,
        });

        return response;
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as RepositoryListBody;
    // Exactly the five fields an import needs — GitHub's numeric id as text, as
    // ProjectSourceBinding.repository_id expects it — and nothing else.
    expect(body.repositories).toEqual([
      {
        id: "4567",
        full_name: "oflabs44/cockpit",
        default_branch: "main",
        private: true,
        archived: false,
      },
      {
        id: "89",
        full_name: "oflabs44/retired",
        default_branch: "trunk",
        private: false,
        archived: true,
      },
    ]);
    expect(body).toMatchObject({ page: 1, per_page: 100, total_count: 2, has_more: false });
  });

  it("pages explicitly rather than passing off one page as the whole grant", async () => {
    const app = authedApp(testDeps());
    const source = await connectedSource();

    const res = await withGithubApi(
      githubRepositoryApi(() => repositoryListing([githubRepository(1, "oflabs44/one")], 250)),
      async (calls) => {
        const response = await listRepositories(
          app,
          source.id,
          "page=2&per_page=100",
          withGithubConfig(),
        );

        expect(calls[1]?.url).toBe(
          "https://api.github.com/installation/repositories?per_page=100&page=2",
        );

        return response;
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as RepositoryListBody;
    expect(body).toMatchObject({ page: 2, per_page: 100, total_count: 250, has_more: true });
  });

  it("refuses a per_page above GitHub's ceiling instead of quietly returning fewer", async () => {
    const app = authedApp(testDeps());
    const source = await connectedSource();

    const res = await withGithubApi(
      githubRepositoryApi(() => new Response("{}", { status: 200 })),
      async (calls) => {
        const response = await listRepositories(
          app,
          source.id,
          "per_page=500",
          withGithubConfig(),
        );
        expect(calls).toHaveLength(0);

        return response;
      },
    );

    expect(res.status).toBe(400);
  });

  it("404s an unknown source, and never asks GitHub for a token", async () => {
    const res = await withGithubApi(
      githubRepositoryApi(() => new Response("{}", { status: 200 })),
      async (calls) => {
        const response = await listRepositories(
          authedApp(testDeps()),
          "src_does_not_exist",
          "",
          withGithubConfig(),
        );
        expect(calls).toHaveLength(0);

        return response;
      },
    );

    expect(res.status).toBe(404);
  });

  it("reports a refused token exchange as GitHub's failure, and never lists", async () => {
    const app = authedApp(testDeps());
    const source = await connectedSource();

    const res = await withGithubApi(
      () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }),
      async (calls) => {
        const response = await listRepositories(app, source.id, "", withGithubConfig());
        // The listing is never attempted without a token.
        expect(calls).toHaveLength(1);

        return response;
      },
    );

    expect(res.status).toBe(502);
  });

  it("reports a refused listing as GitHub's failure", async () => {
    const app = authedApp(testDeps());
    const source = await connectedSource();

    const res = await withGithubApi(
      githubRepositoryApi(
        () => new Response(JSON.stringify({ message: "Forbidden" }), { status: 403 }),
      ),
      () => listRepositories(app, source.id, "", withGithubConfig()),
    );

    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("403");
  });

  // A 200 is not on its own a listing. The two ways of being lenient are both wrong: an
  // empty listing reads as a revoked grant, and mapping a missing field blindly throws a
  // TypeError the route reports as an unusable private key — a fault on this side.
  it("treats a 200 that is not a repository listing as GitHub failing, not as an empty grant", async () => {
    const app = authedApp(testDeps());
    const source = await connectedSource();

    const cases: Record<string, Response> = {
      "not json at all": new Response("<html>502 Bad Gateway</html>", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      "truncated json": new Response('{"total_count": 2, "repositories": [', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      "no repositories array": new Response(JSON.stringify({ total_count: 12 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      "repositories is not an array": new Response(
        JSON.stringify({ total_count: 1, repositories: { id: 1 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      "no total_count": new Response(JSON.stringify({ repositories: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      "a repository missing its name": new Response(
        JSON.stringify({
          total_count: 1,
          repositories: [{ id: 7, private: false, archived: false }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    };

    for (const [name, answer] of Object.entries(cases)) {
      const res = await withGithubApi(
        githubRepositoryApi(() => answer.clone()),
        () => listRepositories(app, source.id, "", withGithubConfig()),
      );

      expect(res.status, name).toBe(502);
      const body = (await res.json()) as { error: string };
      expect(body.error, name).toContain("github");
      // Never a private-key diagnosis, and never the body it could not read.
      expect(body.error, name).not.toContain("GITHUB_APP_PRIVATE_KEY");
      expect(body.error, name).not.toContain("Bad Gateway");
    }
  });

  it("blames the plane, not GitHub, when the app key cannot be used", async () => {
    const app = authedApp(testDeps());
    const source = await connectedSource();

    const res = await withGithubApi(
      githubRepositoryApi(() => new Response("{}", { status: 200 })),
      async (calls) => {
        const response = await listRepositories(
          app,
          source.id,
          "",
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
  });

  it("fails loudly on an unconfigured plane, like the other GitHub routes", async () => {
    const app = authedApp(testDeps());
    const source = await connectedSource();

    const res = await listRepositories(app, source.id, "", withoutGithubConfig());

    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("not configured");
  });

  it("never lets the installation token out — not in a response, not in a log", async () => {
    const app = authedApp(testDeps());
    const source = await connectedSource();
    const logged: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      const ok = await withGithubApi(
        githubRepositoryApi(() => repositoryListing([githubRepository(7, "oflabs44/cockpit")])),
        () => listRepositories(app, source.id, "", withGithubConfig()),
      );
      expect(ok.status).toBe(200);
      expect(await ok.text()).not.toContain(INSTALLATION_TOKEN);

      // The failure path is where a token most easily reaches a log or an error message.
      const failed = await withGithubApi(
        githubRepositoryApi(
          () =>
            new Response(JSON.stringify({ message: `bad token ${INSTALLATION_TOKEN}` }), {
              status: 403,
            }),
        ),
        () => listRepositories(app, source.id, "", withGithubConfig()),
      );
      expect(failed.status).toBe(502);
      expect(await failed.text()).not.toContain(INSTALLATION_TOKEN);
      expect(logged.join("\n")).not.toContain(INSTALLATION_TOKEN);
      expect(logged.join("\n")).toContain("github repository listing failed");
    } finally {
      console.error = originalError;
    }

    // Nothing about the exchange is persisted either.
    expect(JSON.stringify(await sourceRow(source.id))).not.toContain(INSTALLATION_TOKEN);
  });
});
