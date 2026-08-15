// GitHub App integration seam (ADR-0010). Everything that talks to github.com lives here,
// behind one question the routes ask: "what does this installation look like?"
//
// No tokens are persisted anywhere in this file or its callers: the app private key is a
// Worker secret, the app JWT lives for one request, and installation access tokens are a
// later slice (minted on demand at deploy time, never stored).

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
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${jwt}`,
      "user-agent": "cockpit-plane",
      "x-github-api-version": "2022-11-28",
    },
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
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${jwt}`,
      "user-agent": "cockpit-plane",
      "x-github-api-version": "2022-11-28",
    },
  });

  if (res.status === 404) return "not-found";
  if (!res.ok) {
    throw new GitHubApiError(res.status, `github installation delete failed: ${res.status}`);
  }

  return "revoked";
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
