import { createRoute, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { AppRouteHandler } from "../app";
import { db, sources } from "../db";
import { fetchInstallationFacts, GitHubApiError, GitHubConfigError } from "../github";
import { ErrorResponse } from "../schema";

// GitHub redirects the operator's browser here after the app is installed (or its
// repository grant is edited). GitHub redelivers per installation id, so this route
// upserts: first arrival creates the source, later ones refresh it in place.
//
// Browser-navigated, so it never answers with JSON: success and lookup failure both send
// the operator back into the SPA at /sources (the UI refetches the list on arrival).
export const githubSourceCallbackRoute = createRoute({
  method: "get",
  path: "/source-connections/github/callback",
  request: {
    query: z.object({
      // Absent when the installer cannot install the app themselves: GitHub answers their
      // request with setup_action=request and no installation.
      installation_id: z.coerce.number().int().positive().optional(),
      setup_action: z.enum(["install", "update", "request"]).default("install"),
      state: z.string().optional(), // echoed from connect; not yet verified (see connect route)
    }),
  },
  responses: {
    302: {
      description:
        "Back to the web app: /sources?connected=<id> after the upsert, /sources?notice=pending-approval when the install still needs the account owner, /sources?error=github_installation_lookup_failed when GitHub rejects the installation lookup (forged or stale callback)",
      headers: z.object({ Location: z.string() }),
    },
    400: {
      description: "An install/update callback arrived without an installation_id",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

export const githubSourceCallbackHandler: AppRouteHandler<
  typeof githubSourceCallbackRoute
> = async (c) => {
  const { installation_id, setup_action } = c.req.valid("query");

  // The operator asked an account owner to install the app: nothing exists to record yet,
  // so land them back in the app with a notice instead of an error.
  if (setup_action === "request") return c.redirect("/sources?notice=pending-approval", 302);
  if (installation_id === undefined) {
    return c.json({ error: "installation_id is required" }, 400);
  }

  const deps = c.var.deps;
  const now = deps.clock.now();
  const database = db(c.env.DB);

  try {
    // Verified against GitHub as the app (a forged installation_id 404s there). Missing or
    // partial config redirects without writing a row — no local mock install is allowed.
    const facts = await fetchInstallationFacts(c.env, installation_id, now);

    const existing = await database
      .select()
      .from(sources)
      .where(and(eq(sources.provider, "github"), eq(sources.installationId, installation_id)))
      .get();

    if (existing) {
      // Refresh what GitHub owns (login, grant, permissions); keep `name`, which is the
      // operator's display name once a rename route exists.
      await database
        .update(sources)
        .set({
          login: facts.account_login,
          accountId: facts.account_id,
          repositorySelection: facts.repository_selection,
          permissions: facts.permissions,
          events: facts.events,
          updatedAt: now,
        })
        .where(eq(sources.id, existing.id));
      return c.redirect(`/sources?connected=${existing.id}`, 302);
    }

    const id = deps.ids.id("src");
    await database.insert(sources).values({
      id,
      provider: "github",
      name: facts.account_login,
      login: facts.account_login,
      installationId: installation_id,
      accountId: facts.account_id,
      repositorySelection: facts.repository_selection,
      permissions: facts.permissions,
      events: facts.events,
      createdAt: now,
      updatedAt: now,
    });

    return c.redirect(`/sources?connected=${id}`, 302);
  } catch (err) {
    // The detail would be lost in a redirect — log it here so a failed connect is
    // traceable, then land the operator back in the app rather than on raw JSON. Anything
    // unclassified (a key WebCrypto refuses, a D1 constraint) gets the generic code.
    console.error(`github installation callback failed for ${installation_id}`, err);
    const hint =
      err instanceof GitHubConfigError
        ? "github_app_misconfigured"
        : err instanceof GitHubApiError
          ? "github_installation_lookup_failed"
          : "github_connect_failed";
    return c.redirect(`/sources?error=${hint}`, 302);
  }
};
