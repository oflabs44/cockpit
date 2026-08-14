import { createRoute } from "@hono/zod-openapi";
import type { AppRouteHandler } from "../app";
import { ConnectGitHubResponse, ErrorResponse } from "../schema";
import { githubConfigState, installUrl, missingGithubVars } from "../github";

export const connectGithubSourceRoute = createRoute({
  method: "post",
  path: "/source-connections/github/connect",
  responses: {
    200: {
      description: "Install URL for the configured GitHub App",
      content: { "application/json": { schema: ConnectGitHubResponse } },
    },
    500: {
      description:
        "GitHub App config is missing or incomplete (GITHUB_APP_ID / GITHUB_APP_SLUG / GITHUB_APP_PRIVATE_KEY are required)",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

export const connectGithubSourceHandler: AppRouteHandler<
  typeof connectGithubSourceRoute
> = async (c) => {
  const deps = c.var.deps;

  // Missing config fails here, before the operator leaves cockpit. No local mock install:
  // the Sources screen must test the real GitHub App flow.
  if (githubConfigState(c.env) !== "configured") {
    return c.json(
      { error: `github app not configured; missing ${missingGithubVars(c.env).join(", ")}` },
      500,
    );
  }

  // SECURITY: `state` is minted here and echoed back by GitHub, but the callback does not
  // verify it yet — there is no operator session to bind it to until Cloudflare Access
  // lands (same standing caveat as the other operator routes, see app.ts). The callback
  // instead verifies the installation against GitHub itself when the app is configured.
  const state = deps.ids.id("ghstate");

  return c.json({ url: installUrl(c.env, state), state }, 200);
};
