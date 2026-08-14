import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
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
