import { exportPKCS8, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { GitHubApiError, withRepositoryGrant, type GitHubEnv } from "../src/github";

// ADR-0012's fetch/preflight foundation, tested at the module rather than the route: no
// route asks for a grant yet, and the point is grant resolution, revocation, and what must
// never come back out of them. The app JWT is really signed against a key generated
// here; only api.github.com's answers are ours.

const { privateKey: appKey } = await generateKeyPair("RS256", { extractable: true });
const APP_PRIVATE_KEY_PEM = await exportPKCS8(appKey);

const NOW_MS = 1_700_000_000_000;
const INSTALLATION_ID = 4_242;
const REPOSITORY_ID = 987_654;
const SCOPED_TOKEN = "ghs_test_scoped_token_do_not_leak";

function githubConfig(overrides: Partial<GitHubEnv> = {}): GitHubEnv {
  return {
    GITHUB_APP_ID: "12345",
    GITHUB_APP_SLUG: "cockpit-test-app",
    GITHUB_APP_PRIVATE_KEY: APP_PRIVATE_KEY_PEM,
    ...overrides,
  };
}

type GithubCall = {
  url: string;
  method: string;
  authorization: string | null;
  contentType: string | null;
  body: string | null;
  redirect: RequestInit["redirect"];
};

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
      contentType: request.headers.get("content-type"),
      body: request.method === "GET" ? null : await request.text(),
      redirect: init?.redirect,
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Answers the scoped token exchange, then hands the repository lookup to `lookup`. */
function githubRepositoryApi(lookup: (call: GithubCall) => Response) {
  return (call: GithubCall) => {
    if (call.url.endsWith("/access_tokens")) {
      return json({ token: SCOPED_TOKEN, expires_at: "2023-11-14T22:13:20Z" }, 201);
    }
    if (call.url.endsWith("/installation/token")) {
      return new Response(null, { status: 204 });
    }

    return lookup(call);
  };
}

/** What GitHub answers `GET /repositories/{id}` with, reduced to the fields plus noise. */
function githubRepository(id: number, fullName: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    full_name: fullName,
    default_branch: "main",
    private: true,
    // Everything else GitHub sends and the grant must not be built from.
    clone_url: `https://github.com/renamed-away/old-name.git`,
    owner: { login: fullName.split("/")[0] },
    ...overrides,
  };
}

function grantFor(
  repositoryId: string,
  use: Parameters<typeof withRepositoryGrant>[4] = () => {},
  env: GitHubEnv = githubConfig(),
): Promise<void> {
  return withRepositoryGrant(env, INSTALLATION_ID, repositoryId, NOW_MS, use);
}

describe("github: repository grants", () => {
  it("mints a token scoped to one repository, then resolves the clone identity with it", async () => {
    await withGithubApi(
      githubRepositoryApi(() => json(githubRepository(REPOSITORY_ID, "oflabs44/cockpit"))),
      async (calls) => {
        await grantFor(String(REPOSITORY_ID), (grant) => {
          expect(grant).toEqual({
            repository_id: REPOSITORY_ID,
            full_name: "oflabs44/cockpit",
            clone_url: "https://github.com/oflabs44/cockpit.git",
            token: SCOPED_TOKEN,
          });
        });

        expect(calls).toHaveLength(3);
        // As the app, to mint the token — and the body is what narrows it.
        expect(calls[0]?.method).toBe("POST");
        expect(calls[0]?.url).toBe(
          `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`,
        );
        expect(calls[0]?.authorization).toMatch(/^Bearer eyJ/);
        expect(calls[0]?.contentType).toBe("application/json");
        expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({
          repository_ids: [REPOSITORY_ID],
          permissions: { contents: "read" },
        });
        // ...then as the installation, addressing the repository by id, never by name.
        expect(calls[1]?.method).toBe("GET");
        expect(calls[1]?.url).toBe(`https://api.github.com/repositories/${REPOSITORY_ID}`);
        expect(calls[1]?.authorization).toBe(`Bearer ${SCOPED_TOKEN}`);
        // The scoped credential is revoked once the callback has finished using it.
        expect(calls[2]).toMatchObject({
          method: "DELETE",
          url: "https://api.github.com/installation/token",
          authorization: `Bearer ${SCOPED_TOKEN}`,
        });
        expect(calls.every((call) => call.redirect === "manual")).toBe(true);
      },
    );
  });

  it("clones the name GitHub reports now, not the one the Project cached", async () => {
    // The whole reason the id is authoritative: after a rename or transfer, the Project's
    // `repository_full_name` still says the old thing and cloning by it would 404.
    await withGithubApi(
      githubRepositoryApi(() => json(githubRepository(REPOSITORY_ID, "new-owner/renamed"))),
      () =>
        grantFor(String(REPOSITORY_ID), (grant) => {
          expect(grant.full_name).toBe("new-owner/renamed");
          expect(grant.clone_url).toBe("https://github.com/new-owner/renamed.git");
        }),
    );
  });

  it("returns no grant data after the callback finishes", async () => {
    const returned = await withGithubApi(
      githubRepositoryApi(() => json(githubRepository(REPOSITORY_ID, "oflabs44/cockpit"))),
      () =>
        withRepositoryGrant(
          githubConfig(),
          INSTALLATION_ID,
          String(REPOSITORY_ID),
          NOW_MS,
          () => {},
        ),
    );

    expect(returned).toBeUndefined();
  });

  it("refuses an id that is not a positive safe integer, before calling GitHub", async () => {
    const unusable = [
      "0",
      "-1",
      "abc",
      "12.5",
      "1e3",
      " 12",
      "",
      String(Number.MAX_SAFE_INTEGER + 2),
    ];

    await withGithubApi(
      () => json({}, 500),
      async (calls) => {
        for (const id of unusable) {
          await expect(grantFor(id)).rejects.toThrow("not a github repository id");
        }

        expect(calls).toHaveLength(0);
      },
    );
  });

  it("refuses a 200 that answers for a different repository", async () => {
    await withGithubApi(
      githubRepositoryApi(() => json(githubRepository(REPOSITORY_ID + 1, "someone/else"))),
      async () => {
        await expect(grantFor(String(REPOSITORY_ID))).rejects.toThrow(
          "github returned a different repository",
        );
      },
    );
  });

  it("refuses a 200 whose id is text, missing, or not a number at all", async () => {
    for (const id of [String(REPOSITORY_ID), null, undefined, { id: REPOSITORY_ID }]) {
      await withGithubApi(
        githubRepositoryApi(() => json({ id, full_name: "oflabs44/cockpit" })),
        async () => {
          await expect(grantFor(String(REPOSITORY_ID))).rejects.toThrow(
            "github returned a different repository",
          );
        },
      );
    }
  });

  it("refuses a 200 with no usable full_name rather than building a clone URL from it", async () => {
    const unusable = [
      undefined,
      "",
      "cockpit",
      "oflabs44/cockpit/extra",
      "oflabs44/../etc",
      "../cockpit",
      "./cockpit",
      "oflabs44/..",
      12,
      null,
    ];

    for (const fullName of unusable) {
      await withGithubApi(
        githubRepositoryApi(() => json({ id: REPOSITORY_ID, full_name: fullName })),
        async () => {
          await expect(grantFor(String(REPOSITORY_ID))).rejects.toThrow(
            "github returned a repository this plane cannot read",
          );
        },
      );
    }
  });

  it("reads a 200 that is not JSON as an upstream failure, not an internal parse bug", async () => {
    await withGithubApi(
      githubRepositoryApi(
        () => new Response("<html>gateway</html>", { headers: { "content-type": "application/json" } }),
      ),
      async () => {
        const error = await grantFor(String(REPOSITORY_ID)).catch((thrown: unknown) => thrown);

        expect(error).toBeInstanceOf(GitHubApiError);
        expect((error as GitHubApiError).status).toBe(502);
        expect((error as GitHubApiError).message).toBe("github returned an unreadable repository");
      },
    );
  });

  it("carries GitHub's status, and nothing of the token or the body, into every error", async () => {
    const secretish = "oflabs44/private-name-that-must-not-travel";

    const errors = await withGithubApi(
      githubRepositoryApi((call) =>
        call.url.endsWith(`/${REPOSITORY_ID}`)
          ? json({ id: REPOSITORY_ID + 1, full_name: secretish, description: SCOPED_TOKEN }, 200)
          : json({ message: "Not Found" }, 404),
      ),
      async () => {
        const mismatched = await grantFor(String(REPOSITORY_ID)).catch((thrown: unknown) => thrown);
        const notFound = await grantFor(String(REPOSITORY_ID + 5)).catch((thrown: unknown) => thrown);
        return [mismatched, notFound] as GitHubApiError[];
      },
    );

    for (const error of errors) {
      expect(error).toBeInstanceOf(GitHubApiError);
      expect(error.message).not.toContain(SCOPED_TOKEN);
      expect(error.message).not.toContain(secretish);
      expect(error.stack ?? "").not.toContain(SCOPED_TOKEN);
    }
    expect(errors[1]?.status).toBe(404);
    expect(errors[1]?.message).toBe("github repository lookup failed: 404");
  });

  it("refuses before any GitHub call when the app is not configured", async () => {
    await withGithubApi(
      () => json({}, 500),
      async (calls) => {
        await expect(
          grantFor(String(REPOSITORY_ID), () => {}, githubConfig({ GITHUB_APP_PRIVATE_KEY: undefined })),
        ).rejects.toThrow("github app not configured");

        expect(calls).toHaveLength(0);
      },
    );
  });
});
