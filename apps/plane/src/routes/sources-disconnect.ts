import { createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import type { AppRouteHandler } from "../app";
import { db, sources } from "../db";
import {
  deleteInstallation,
  GitHubApiError,
  GitHubConfigError,
  githubConfigState,
  missingGithubVars,
} from "../github";
import { DisconnectSourceBody, DisconnectSourceResponse, ErrorResponse } from "../schema";

export const disconnectSourceRoute = createRoute({
  method: "delete",
  path: "/source-connections/{id}",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: DisconnectSourceBody } } },
  },
  responses: {
    200: {
      description: "Installation revoked on GitHub and the connection removed",
      content: { "application/json": { schema: DisconnectSourceResponse } },
    },
    400: {
      description: "The confirmation did not match the connection's github_login",
      content: { "application/json": { schema: ErrorResponse } },
    },
    404: { description: "No such source" },
    500: {
      description:
        "GitHub App config is missing or incomplete, or the plane could not sign a request to GitHub (an unusable GITHUB_APP_PRIVATE_KEY); the connection is left alone",
      content: { "application/json": { schema: ErrorResponse } },
    },
    502: {
      description: "GitHub refused the revoke; the connection is left alone",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

export const disconnectSourceHandler: AppRouteHandler<typeof disconnectSourceRoute> = async (
  c,
) => {
  const { id } = c.req.valid("param");
  const { confirm } = c.req.valid("json");
  const database = db(c.env.DB);

  const row = await database.select().from(sources).where(eq(sources.id, id)).get();
  if (!row) return c.body(null, 404);

  // Case-insensitive, because GitHub logins are: a script driving the documented API with
  // "OflAbs44" is confirming correctly.
  if (confirm.toLowerCase() !== row.login.toLowerCase()) {
    return c.json({ error: `confirm must be the connection's github_login (${row.login})` }, 400);
  }

  // Nothing in the schema points at a source connection today: an app resource's
  // configuration carries a repo URL or an image, not a connection id, and there is no
  // `links` table yet. When either gains a reference, this is where the refusal goes —
  // deleting a referenced connection would orphan whatever pointed at it.

  // Same failure as the other GitHub routes: without full config the plane cannot speak to
  // GitHub as the app, and a disconnect that skipped the revoke would leave the app
  // installed with no local record — the state that makes the connect flow dead-end.
  if (githubConfigState(c.env) !== "configured") {
    return c.json(
      { error: `github app not configured; missing ${missingGithubVars(c.env).join(", ")}` },
      500,
    );
  }

  let outcome: "revoked" | "not-found";
  try {
    // GitHub first, then the row. The reverse order can drop cockpit's record while the app
    // is still installed, which is exactly what the operator cannot recover from in the UI.
    outcome = await deleteInstallation(c.env, row.installationId, c.var.deps.clock.now());
  } catch (err) {
    console.error(`github installation delete failed for ${row.installationId}`, err);

    // Only an answer from GitHub is a 502. Everything else never left the Worker — a
    // private key WebCrypto refuses is the easy one, since GitHub hands out PKCS#1 and
    // importKey wants PKCS#8 — and telling the operator GitHub refused sends them to retry
    // against a fault on this side. The callback route draws the same line.
    if (err instanceof GitHubApiError) {
      return c.json(
        {
          error: `github refused to revoke the installation (${err.status}); the connection was left connected`,
        },
        502,
      );
    }

    if (err instanceof GitHubConfigError) {
      return c.json({ error: `${err.message}; the connection was left connected` }, 500);
    }

    return c.json(
      {
        error:
          "the plane could not sign a request to GitHub; check GITHUB_APP_PRIVATE_KEY is PKCS#8 " +
          "(convert GitHub's download with `openssl pkcs8 -topk8 -nocrypt`). " +
          "The connection was left connected",
      },
      500,
    );
  }

  await database.delete(sources).where(eq(sources.id, id));

  return c.json({ id, revoked_on_github: outcome === "revoked" }, 200);
};
