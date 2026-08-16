import { createRoute, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { AppRouteHandler } from "../app";
import { db, sources } from "../db";
import {
  fetchInstallationRepositories,
  GitHubApiError,
  GitHubConfigError,
  githubConfigState,
  MAX_REPOSITORY_PAGE_SIZE,
  missingGithubVars,
} from "../github";
import { ErrorResponse, RepositoryListResponse } from "../schema";

// ADR-0012: the operator picks a repository here, then imports it as a Project. Nothing is
// mirrored — the grant lives on github.com and is read on request, so a repository added or
// removed there shows up on the next call rather than after a sync.
export const listSourceRepositoriesRoute = createRoute({
  method: "get",
  path: "/source-connections/{id}/repositories",
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({
      page: z.coerce.number().int().positive().default(1),
      per_page: z.coerce
        .number()
        .int()
        .min(1)
        .max(MAX_REPOSITORY_PAGE_SIZE)
        .default(MAX_REPOSITORY_PAGE_SIZE),
    }),
  },
  responses: {
    200: {
      description: "One page of the repositories granted to this installation",
      content: { "application/json": { schema: RepositoryListResponse } },
    },
    400: {
      description: "Invalid page or per_page",
      content: { "application/json": { schema: ErrorResponse } },
    },
    404: { description: "No such GitHub source" },
    500: {
      description:
        "GitHub App config is missing or incomplete, or the plane could not sign a request to GitHub (an unusable GITHUB_APP_PRIVATE_KEY)",
      content: { "application/json": { schema: ErrorResponse } },
    },
    502: {
      description: "GitHub refused the token exchange or the repository listing",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

export const listSourceRepositoriesHandler: AppRouteHandler<
  typeof listSourceRepositoriesRoute
> = async (c) => {
  const { id } = c.req.valid("param");
  const { page, per_page } = c.req.valid("query");

  // Provider is part of the lookup rather than a separate check: this route can only speak
  // to GitHub, so a source of any other provider simply is not one of its repository lists.
  const row = await db(c.env.DB)
    .select()
    .from(sources)
    .where(and(eq(sources.id, id), eq(sources.provider, "github")))
    .get();
  if (!row) return c.body(null, 404);

  if (githubConfigState(c.env) !== "configured") {
    return c.json(
      { error: `github app not configured; missing ${missingGithubVars(c.env).join(", ")}` },
      500,
    );
  }

  try {
    const listing = await fetchInstallationRepositories(
      c.env,
      row.installationId,
      { page, perPage: per_page },
      c.var.deps.clock.now(),
    );

    return c.json(
      {
        repositories: listing.repositories,
        page,
        per_page,
        total_count: listing.total_count,
        has_more: page * per_page < listing.total_count,
      },
      200,
    );
  } catch (err) {
    // Safe to log: the installation token never reaches a caller, and GitHubApiError
    // carries a status, not a response body.
    console.error(`github repository listing failed for installation ${row.installationId}`, err);

    // Same line as the disconnect route: only an answer from GitHub is a 502. A key
    // WebCrypto refuses never left the Worker, and blaming GitHub for it sends the
    // operator to retry against a fault on this side.
    //
    // The error's own message is returned rather than a sentence built from its status: a
    // 200 whose body is not a listing is upstream's failure too, and "refused (200)" would
    // be a lie. Every GitHubApiError message is fixed text plus a status — never a response
    // body, never a token — so it is safe to hand back.
    if (err instanceof GitHubApiError) {
      return c.json({ error: err.message }, 502);
    }

    if (err instanceof GitHubConfigError) return c.json({ error: err.message }, 500);

    return c.json(
      {
        error:
          "the plane could not sign a request to GitHub; check GITHUB_APP_PRIVATE_KEY is PKCS#8 " +
          "(convert GitHub's download with `openssl pkcs8 -topk8 -nocrypt`)",
      },
      500,
    );
  }
};
