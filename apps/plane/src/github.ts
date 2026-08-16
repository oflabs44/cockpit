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
    redirect: "manual",
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
    redirect: "manual",
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

  try {
    const res = await fetch(url, {
      headers: githubHeaders(`Bearer ${token}`),
      redirect: "manual",
    });
    if (!res.ok) {
      throw new GitHubApiError(res.status, `github repository listing failed: ${res.status}`);
    }

    return parseRepositoryPage(await readJson(res, "repository listing"));
  } finally {
    await revokeInstallationToken(token);
  }
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

// --- repository grants ---------------------------------------------------------------
// ADR-0012's fetch/preflight foundation. A Project deploys from `repository_id`, never from
// `repository_full_name` (docs/type-design.md §2.2): the name is a display cache that is
// wrong from the moment the repository is renamed or transferred. So the clone identity is
// resolved here, from the id, through the installation, every time it is needed.

/** A repository resolved from its id, plus the credential that can read it, for one call. */
interface RepositoryGrant {
  /** GitHub's numeric id, as GitHub itself confirmed it. Always equals the id asked for. */
  repository_id: number;
  /** The repository's name on github.com *now* — the Project's cached name may differ. */
  full_name: string;
  /** Canonical HTTPS clone URL, built from `full_name`. Carries no credential. */
  clone_url: string;
  /**
   * Installation access token scoped to this one repository, read-only on contents. Valid
   * for the callback only: it must not be stored, returned to a client, or logged.
   */
  token: string;
}

/** Digits only: the text form of a JSON number, with no sign, point or exponent. */
const REPOSITORY_ID_PATTERN = /^[0-9]+$/;

/** owner/name, the only shape that can be pasted into a clone URL unescaped. */
const FULL_NAME_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function isFullName(value: unknown): value is string {
  if (typeof value !== "string" || !FULL_NAME_PATTERN.test(value)) return false;

  // A malformed upstream response must not turn URL path segments into traversal.
  return value.split("/").every((segment) => segment !== "." && segment !== "..");
}

/**
 * Resolve a repository by its authoritative numeric id and lend the callback a grant that
 * can read it. It resolves the grant with two GitHub calls:
 *
 * 1. `POST /app/installations/{id}/access_tokens`, as the app (Bearer JWT), with
 *    `repository_ids: [id]` and `permissions: { contents: "read" }` — the documented way to
 *    narrow an installation token to one repository and one permission. Without a body the
 *    token would carry the installation's whole grant.
 * 2. `GET /repositories/{id}`, as that installation — the id-addressed form of the
 *    repository endpoint, which is what survives a rename or a transfer.
 *
 * The token is never persisted, logged, returned to a route, or placed in an error. A revoke
 * is attempted after `use`; if it fails, GitHub expires the token within one hour.
 */
export async function withRepositoryGrant(
  env: GitHubEnv,
  installationId: number,
  repositoryId: string,
  nowMs: number,
  use: (grant: RepositoryGrant) => Promise<void> | void,
): Promise<void> {
  if (githubConfigState(env) !== "configured") throw new GitHubConfigError(env);

  const id = parseRepositoryId(repositoryId);
  const token = await mintInstallationToken(env, installationId, nowMs, {
    repository_ids: [id],
    permissions: { contents: "read" },
  });

  try {
    const res = await fetch(`https://api.github.com/repositories/${id}`, {
      headers: githubHeaders(`Bearer ${token}`),
      redirect: "manual",
    });
    if (!res.ok) {
      throw new GitHubApiError(res.status, `github repository lookup failed: ${res.status}`);
    }

    const repo = (await readJson(res, "repository")) as { id?: unknown; full_name?: unknown } | null;

    if (repo?.id !== id) {
      throw new GitHubApiError(502, "github returned a different repository than the one asked for");
    }
    if (!isFullName(repo.full_name)) {
      throw new GitHubApiError(502, "github returned a repository this plane cannot read");
    }

    await use({
      repository_id: id,
      full_name: repo.full_name,
      clone_url: `https://github.com/${repo.full_name}.git`,
      token,
    });
  } finally {
    await revokeInstallationToken(token);
  }
}

/**
 * `ProjectSourceBinding.repository_id` is text (schema.ts), so an id that is not a positive
 * safe integer never reaches GitHub: `repository_ids` is a JSON number array, and a value
 * past 2^53-1 would silently become a *different* id on the way out.
 */
function parseRepositoryId(repositoryId: string): number {
  const id = REPOSITORY_ID_PATTERN.test(repositoryId) ? Number(repositoryId) : Number.NaN;

  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new GitHubApiError(500, "the project's stored repository id is not a github repository id");
  }

  return id;
}

/**
 * Exchange the app JWT for an installation access token (GitHub expires it after an hour;
 * cockpit discards it immediately). Deliberately not exported: a token that no caller can
 * hold is a token no caller can store, return in a response, or log.
 *
 * `scope` narrows the token: POST /app/installations/{id}/access_tokens accepts
 * `repository_ids` (integers) and `permissions`, and omitting them mints a token carrying
 * everything the installation granted. Only `withRepositoryGrant` passes a scope; the
 * listing above deliberately does not, because it must see the whole grant.
 */
async function mintInstallationToken(
  env: GitHubEnv,
  installationId: number,
  nowMs: number,
  scope?: { repository_ids: number[]; permissions: Record<string, string> },
): Promise<string> {
  const jwt = await appJwt(env.GITHUB_APP_ID!, env.GITHUB_APP_PRIVATE_KEY!, nowMs);
  const headers = githubHeaders(`Bearer ${jwt}`);
  if (scope) headers["content-type"] = "application/json";

  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers,
      body: scope ? JSON.stringify(scope) : undefined,
      redirect: "manual",
    },
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

/** Best-effort cleanup; a failed revoke leaves GitHub's one-hour expiry as the bound. */
async function revokeInstallationToken(token: string): Promise<void> {
  try {
    await fetch("https://api.github.com/installation/token", {
      method: "DELETE",
      headers: githubHeaders(`Bearer ${token}`),
      redirect: "manual",
    });
  } catch {
    // Revocation must not replace the repository operation's result.
  }
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
