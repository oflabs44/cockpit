// GitHub App integration seam (ADR-0010). Everything that talks to github.com lives here,
// behind one question the routes ask: "what does this installation look like?"
//
// No tokens are persisted anywhere in this file or its callers: the app private key is a
// Worker secret, the app JWT lives for one request, and an installation access token is
// minted on demand, used for the one call that needs it, and never returned, stored or
// logged — it stays inside this module.

// A 404 from api.github.com/app/installations/{id} means *this* App has no such
// installation, and the two causes are indistinguishable from here: it was uninstalled on
// github.com, or it belongs to a different App than GITHUB_APP_ID identifies. The lookup
// treats that as fatal (nothing to record); the delete removes the row anyway and reports
// it, because refusing would strand a row whose installation really is gone.
export interface GitHubEnv {
  GITHUB_APP_ID?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
}

/** What the plane keeps about an installation — GitHub's record, minus anything secret. */
export interface InstallationFacts {
  account_login: string;
  account_id: number | null;
  repository_selection: "all" | "selected";
  permissions: Record<string, string>;
  events: string[];
}

// The three vars are one unit: the slug sends the operator to github.com, the id and key
// verify what comes back. No local mock install is allowed: without the full set the
// operator cannot test the real GitHub flow, so connect/callback fail loudly.
export type GitHubConfigState = "unconfigured" | "partial" | "configured";

const GITHUB_VARS = ["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_PRIVATE_KEY"] as const;

export function githubConfigState(env: GitHubEnv): GitHubConfigState {
  const present = GITHUB_VARS.filter((name) => env[name]).length;
  if (present === 0) return "unconfigured";
  return present === GITHUB_VARS.length ? "configured" : "partial";
}

export function missingGithubVars(env: GitHubEnv): string[] {
  return GITHUB_VARS.filter((name) => !env[name]);
}

/** Thrown when the flow is reached without complete GitHub App config. */
export class GitHubConfigError extends Error {
  constructor(env: GitHubEnv) {
    super(`github app not configured; missing ${missingGithubVars(env).join(", ")}`);
  }
}

/**
 * The URL the operator's browser visits to install the app. Callers must have rejected
 * missing config before asking.
 */
export function installUrl(env: GitHubEnv, state: string): string {
  if (githubConfigState(env) !== "configured") throw new GitHubConfigError(env);

  // select_target, not the more obvious installations/new: GitHub drops the state parameter
  // when redirecting to the setup URL from installations/new, and preserves it from this one.
  return `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/select_target?state=${encodeURIComponent(state)}`;
}

/**
 * Fetch the installation from GitHub, authenticated as the app (JWT). `nowMs` comes from
 * `deps.clock` — docs/type-design.md §1, no `Date.now()` in plane logic.
 */
export async function fetchInstallationFacts(
  env: GitHubEnv,
  installationId: number,
  nowMs: number,
): Promise<InstallationFacts> {
  if (githubConfigState(env) !== "configured") throw new GitHubConfigError(env);

  const jwt = await appJwt(env.GITHUB_APP_ID!, env.GITHUB_APP_PRIVATE_KEY!, nowMs);
  const res = await fetch(`https://api.github.com/app/installations/${installationId}`, {
    headers: githubHeaders(`Bearer ${jwt}`),
  });
  if (!res.ok) {
    // 404: see the note above GitHubEnv.
    throw new GitHubApiError(res.status, `github installation lookup failed: ${res.status}`);
  }

  const data = (await res.json()) as {
    account: { login: string; id: number } | null;
    repository_selection: "all" | "selected";
    permissions: Record<string, string>;
    events: string[];
  };
  return {
    account_login: data.account?.login ?? "unknown",
    account_id: data.account?.id ?? null,
    repository_selection: data.repository_selection,
    permissions: data.permissions ?? {},
    events: data.events ?? [],
  };
}

/**
 * Revoke the installation on GitHub — the app stops having access to the account's
 * repositories. Authenticated as the app, like the lookup above. `not-found` is not read as
 * "definitely uninstalled": see the note above GitHubEnv.
 */
export async function deleteInstallation(
  env: GitHubEnv,
  installationId: number,
  nowMs: number,
): Promise<"revoked" | "not-found"> {
  if (githubConfigState(env) !== "configured") throw new GitHubConfigError(env);

  const jwt = await appJwt(env.GITHUB_APP_ID!, env.GITHUB_APP_PRIVATE_KEY!, nowMs);
  const res = await fetch(`https://api.github.com/app/installations/${installationId}`, {
    method: "DELETE",
    headers: githubHeaders(`Bearer ${jwt}`),
  });

  if (res.status === 404) return "not-found";
  if (!res.ok) {
    throw new GitHubApiError(res.status, `github installation delete failed: ${res.status}`);
  }

  return "revoked";
}

// --- repositories --------------------------------------------------------------------

/** One repository the installation can reach, reduced to what an operator selects it by. */
export interface RepositoryFacts {
  /** GitHub's numeric id as text, the form ProjectSourceBinding.repository_id expects. */
  id: string;
  full_name: string;
  default_branch: string;
  private: boolean;
  archived: boolean;
}

export interface RepositoryPage {
  repositories: RepositoryFacts[];
  /** Every repository granted to the installation, not just this page. */
  total_count: number;
}

/** GitHub's own ceiling for `per_page`; asking for more silently gets 100 back. */
export const MAX_REPOSITORY_PAGE_SIZE = 100;

/**
 * One page of the repositories granted to this installation. Paging is the caller's
 * (and the operator's) to drive: an account can grant more than one page, and quietly
 * returning the first 100 of 300 would look like the grant itself is short.
 *
 * Authenticated as the *installation*, not the app — `/app/installations/{id}` (above) is
 * the endpoint that accepts the app JWT, but repository access needs an access token minted
 * for that installation. The token is created here, spent on the one request below, and
 * never leaves this function.
 */
export async function fetchInstallationRepositories(
  env: GitHubEnv,
  installationId: number,
  page: { page: number; perPage: number },
  nowMs: number,
): Promise<RepositoryPage> {
  if (githubConfigState(env) !== "configured") throw new GitHubConfigError(env);

  const token = await mintInstallationToken(env, installationId, nowMs);
  const url = new URL("https://api.github.com/installation/repositories");
  url.searchParams.set("per_page", String(page.perPage));
  url.searchParams.set("page", String(page.page));

  const res = await fetch(url, { headers: githubHeaders(`Bearer ${token}`) });
  if (!res.ok) {
    throw new GitHubApiError(res.status, `github repository listing failed: ${res.status}`);
  }

  return parseRepositoryPage(await readJson(res, "repository listing"));
}

/**
 * A 200 is not on its own a repository listing, and the two obvious ways of being lenient
 * are both wrong. `total_count ?? 0` with `repositories ?? []` turns an unreadable answer
 * into "this installation grants nothing", which an operator reads as a revoked grant; and
 * mapping an entry blindly throws a TypeError, which the route's last branch reports as an
 * unusable GITHUB_APP_PRIVATE_KEY — a fault on this side, sending the operator to fix a key
 * that is fine. Anything short of the shape below is GitHub failing upstream, said as such.
 *
 * Nothing from the body travels in the error: these messages are fixed text.
 */
function parseRepositoryPage(data: unknown): RepositoryPage {
  const page = (data ?? {}) as { total_count?: unknown; repositories?: unknown };

  if (!Number.isSafeInteger(page.total_count) || (page.total_count as number) < 0) {
    throw new GitHubApiError(502, "github returned a repository listing with no total_count");
  }

  if (!Array.isArray(page.repositories)) {
    throw new GitHubApiError(502, "github returned a repository listing with no repositories");
  }

  return {
    total_count: page.total_count as number,
    repositories: page.repositories.map(parseRepository),
  };
}

function parseRepository(entry: unknown): RepositoryFacts {
  const repo = (entry ?? {}) as Record<string, unknown>;
  const branch = repo.default_branch;

  if (
    !Number.isSafeInteger(repo.id) ||
    (repo.id as number) <= 0 ||
    typeof repo.full_name !== "string" ||
    repo.full_name === "" ||
    typeof repo.private !== "boolean" ||
    typeof repo.archived !== "boolean" ||
    !(branch === undefined || branch === null || typeof branch === "string")
  ) {
    throw new GitHubApiError(502, "github returned a repository this plane cannot read");
  }

  return {
    id: String(repo.id),
    full_name: repo.full_name,
    // Absent on a repository with no commits yet; there is no branch to deploy, and
    // inventing one would put a ref in the import body that does not exist.
    default_branch: typeof branch === "string" ? branch : "",
    private: repo.private,
    archived: repo.archived,
  };
}

/**
 * A body GitHub said was JSON and is not — a proxy's error page, a truncated response — is
 * an upstream failure like any other status, not a parse bug to surface as an internal one.
 */
async function readJson(res: Response, what: string): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new GitHubApiError(502, `github returned an unreadable ${what}`);
  }
}

/**
 * Exchange the app JWT for an installation access token (GitHub expires it after an hour;
 * cockpit discards it immediately). Deliberately not exported: a token that no caller can
 * hold is a token no caller can store, return in a response, or log.
 */
async function mintInstallationToken(
  env: GitHubEnv,
  installationId: number,
  nowMs: number,
): Promise<string> {
  const jwt = await appJwt(env.GITHUB_APP_ID!, env.GITHUB_APP_PRIVATE_KEY!, nowMs);
  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    { method: "POST", headers: githubHeaders(`Bearer ${jwt}`) },
  );
  if (!res.ok) {
    throw new GitHubApiError(res.status, `github installation token exchange failed: ${res.status}`);
  }

  const data = (await readJson(res, "token exchange")) as { token?: unknown } | null;
  if (typeof data?.token !== "string" || data.token === "") {
    throw new GitHubApiError(502, "github returned no installation token");
  }

  return data.token;
}

function githubHeaders(authorization: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization,
    "user-agent": "cockpit-plane",
    "x-github-api-version": "2022-11-28",
  };
}

export class GitHubApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// --- app JWT -------------------------------------------------------------------------

/**
 * RS256 app JWT per GitHub's spec: iat backdated 60s for clock drift, 10 minute maximum
 * lifetime. GITHUB_APP_PRIVATE_KEY must be PKCS#8 PEM — GitHub downloads keys as PKCS#1,
 * convert once with `openssl pkcs8 -topk8 -nocrypt` before `wrangler secret put`
 * (WebCrypto's importKey only accepts pkcs8).
 */
async function appJwt(appId: string, privateKeyPem: string, nowMs: number): Promise<string> {
  const nowS = Math.floor(nowMs / 1000);
  const header = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify({ iat: nowS - 60, exp: nowS + 9 * 60, iss: appId })),
  );
  const signingInput = `${header}.${payload}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function pemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s/g, "");
  const raw = atob(body);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
