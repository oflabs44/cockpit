import { OpenAPIHono } from "@hono/zod-openapi";
import type { RouteConfig, RouteHandler } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { csrf } from "hono/csrf";
import { bodyLimit } from "hono/body-limit";
import { etag } from "hono/etag";
import type { Deps } from "./deps";
import { realDeps } from "./deps";
import { healthRoute, healthHandler } from "./routes/health";
import { createServerRoute, createServerHandler } from "./routes/servers-create";
import { listServersRoute, listServersHandler } from "./routes/servers-list";
import { getServerRoute, getServerHandler } from "./routes/servers-detail";
import { listEnrolmentsRoute, listEnrolmentsHandler } from "./routes/enrolments-list";
import { redeemEnrolmentRoute, redeemEnrolmentHandler } from "./routes/enrolments-redeem";
import {
  listServerResourcesRoute,
  listServerResourcesHandler,
} from "./routes/servers-resources-list";
import { createProjectRoute, createProjectHandler } from "./routes/projects-create";
import { listProjectsRoute, listProjectsHandler } from "./routes/projects-list";
import { getProjectRoute, getProjectHandler } from "./routes/projects-detail";
import {
  createProjectResourceRoute,
  createProjectResourceHandler,
} from "./routes/project-resources-create";
import {
  listProjectDeploymentsRoute,
  listProjectDeploymentsHandler,
} from "./routes/project-deployments-list";
import { getResourceRoute, getResourceHandler } from "./routes/resources-detail";
import {
  updateResourceConfigurationRoute,
  updateResourceConfigurationHandler,
} from "./routes/resources-configuration-update";
import {
  listResourceDeploymentsRoute,
  listResourceDeploymentsHandler,
} from "./routes/resource-deployments-list";
import {
  createResourceDeploymentRoute,
  createResourceDeploymentHandler,
} from "./routes/resource-deployments-create";
import { getDeploymentRoute, getDeploymentHandler } from "./routes/deployments-detail";
import { getOperationRoute, getOperationHandler } from "./routes/operations-detail";
import { listSourcesRoute, listSourcesHandler } from "./routes/sources-list";
import { getSourceRoute, getSourceHandler } from "./routes/sources-detail";
import {
  connectGithubSourceRoute,
  connectGithubSourceHandler,
} from "./routes/sources-github-connect";
import {
  githubSourceCallbackRoute,
  githubSourceCallbackHandler,
} from "./routes/sources-github-callback";
import { daemonWsHandler } from "./routes/daemon-ws";
import { accessAuth } from "./access";
import type { AccessOptions, Identity } from "./access";
import type { ServerDO } from "./durable-objects/server-do";

export type Variables = { deps: Deps; identity: Identity };
// `wrangler types` cannot know SERVER_DO's RPC surface, so it generates a bare
// `DurableObjectNamespace`. Declared fresh (not `Omit<Env, ...> & {...}`) rather than derived
// from the generated `Env` — deriving via `Omit` on a binding set that includes a
// `DurableObjectNamespace<ServerDO>` pointing back at `Env` itself sent the RPC `Provider<T>`
// mapped type into "Type instantiation is excessively deep" on every stub call; a plain
// interface breaks the cycle TypeScript was trying to fully resolve.
export interface Bindings {
  DB: D1Database;
  SERVER_DO: DurableObjectNamespace<ServerDO>;
  ASSETS: Fetcher;
  // GitHub App config (ADR-0010). Optional at the type level because local dev/tests may
  // omit them, but the Sources connect/callback flow refuses to run unless all three are
  // present. GITHUB_APP_ID and GITHUB_APP_SLUG are vars; GITHUB_APP_PRIVATE_KEY (PKCS#8
  // PEM) is a secret set via `wrangler secret put`.
  GITHUB_APP_ID?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  // Cloudflare Access. Optional at the type level because `wrangler types` cannot know
  // whether they are set, but operator routes refuse to serve (503) unless both are —
  // src/access.ts. ACCESS_TEAM_DOMAIN is `<team>.cloudflareaccess.com`; ACCESS_AUD is the
  // Access application's AUD tag. Both are vars, not secrets: neither is a credential.
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  // The single deliberate way past authentication, for `wrangler dev`, which has no Access
  // in front of it. Set it in .dev.vars or with `wrangler dev --var COCKPIT_DEV_NO_AUTH:1` —
  // the host shell's environment does not reach the Worker. Never set it on a deployed plane.
  COCKPIT_DEV_NO_AUTH?: string;
}
export type AppEnv = { Bindings: Bindings; Variables: Variables };

/** Handler type for route files: pairs a `createRoute` definition with its controller. */
export type AppRouteHandler<R extends RouteConfig> = RouteHandler<R, AppEnv>;

/**
 * App factory: `deps` (clock, id generation) is injected rather than reached for as a
 * global, per docs/type-design.md §1 — no `Date.now()`/`Math.random()` in plane logic.
 */
export function createApp(deps: Deps = realDeps, access: AccessOptions = {}) {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {

      if (!result.success) return c.json({ error: result.error.message }, 400);
    },
  });

  // `/daemon`'s 101 response carries a live `webSocket` with headers the runtime makes
  // immutable — `secureHeaders()`/`requestId()` mutating them after `next()` throws
  // ("Can't modify immutable headers"), found by running the WS handshake test, not from
  // memory. None of the JSON-request middleware below applies to an upgrade anyway, so the
  // whole stack skips this one path rather than special-casing each middleware.
  const exceptDaemon = (mw: MiddlewareHandler<AppEnv>): MiddlewareHandler<AppEnv> => {
    return (c, next) => (c.req.path === "/daemon" ? next() : mw(c, next));
  };

  app.use("*", exceptDaemon(requestId({ generator: () => deps.ids.id("req") })));
  app.use("*", exceptDaemon(secureHeaders()));
  // No `cors()`: Hono's `csrf()` below only inspects form-encoded/multipart/text-plain bodies
  // (it checks Content-Type, not method) and lets `application/json` requests through
  // regardless of origin. The absence of `cors()` is therefore the ONLY thing stopping a
  // cross-origin page from POSTing JSON to this Worker today — adding `cors()` back would
  // silently remove that defence, not just permit reads.
  app.use("*", exceptDaemon(bodyLimit({ maxSize: 1 * 1024 * 1024 }))); // 1mb; no route needs more yet
  // csrf() only inspects state-changing methods (POST/PUT/PATCH/DELETE) and passes GET/HEAD
  // through untouched, so mounting it on "*" already matches "csrf on mutating routes"
  // (docs/architecture.md §2.1) without a per-route split.
  app.use("*", exceptDaemon(csrf()));
  // Scoped to GET/HEAD: etag hashes the body to produce a cache-validation header, which is
  // meaningless (and wasteful) on errors and on mutating responses once those exist.
  app.use(
    "*",
    exceptDaemon(async (c, next) => {
      if (c.req.method === "GET" || c.req.method === "HEAD") return etag()(c, next);
      return next();
    }),
  );

  app.use("*", async (c, next) => {
    c.set("deps", deps);
    await next();
  });

  // Every operator route is authenticated, and `/daemon` is the only exception: a daemon
  // holds a per-server credential and cannot perform an Access login, so daemon-ws.ts
  // authenticates that credential itself. Mounted after `deps` so a 401 still carries the
  // request id, and before the routes so nothing can be added below it unprotected.
  app.use("*", exceptDaemon(accessAuth(access)));

  app.openapi(healthRoute, healthHandler);
  app.openapi(createServerRoute, createServerHandler);
  app.openapi(listServersRoute, listServersHandler);
  app.openapi(getServerRoute, getServerHandler);
  app.openapi(listEnrolmentsRoute, listEnrolmentsHandler);
  app.openapi(redeemEnrolmentRoute, redeemEnrolmentHandler);
  app.openapi(listServerResourcesRoute, listServerResourcesHandler);
  app.openapi(createProjectRoute, createProjectHandler);
  app.openapi(listProjectsRoute, listProjectsHandler);
  app.openapi(getProjectRoute, getProjectHandler);
  app.openapi(createProjectResourceRoute, createProjectResourceHandler);
  app.openapi(listProjectDeploymentsRoute, listProjectDeploymentsHandler);
  app.openapi(getResourceRoute, getResourceHandler);
  app.openapi(updateResourceConfigurationRoute, updateResourceConfigurationHandler);
  app.openapi(listResourceDeploymentsRoute, listResourceDeploymentsHandler);
  app.openapi(createResourceDeploymentRoute, createResourceDeploymentHandler);
  app.openapi(getDeploymentRoute, getDeploymentHandler);
  app.openapi(getOperationRoute, getOperationHandler);
  app.openapi(listSourcesRoute, listSourcesHandler);
  app.openapi(getSourceRoute, getSourceHandler);
  app.openapi(connectGithubSourceRoute, connectGithubSourceHandler);
  app.openapi(githubSourceCallbackRoute, githubSourceCallbackHandler);
  app.get("/daemon", daemonWsHandler);

  // `run_worker_first: ["/*", ...]` (apps/plane/wrangler.jsonc) routes every request through
  // this Worker, including the UI's own paths — so an unmatched route here falls back to the
  // built SPA shell (index.html, client-side router takes over) rather than a bare Hono 404.
  // `env.ASSETS` is unset in plain `app.request()` unit tests (no real Workers runtime, no
  // assets binding to mock) — fall through to Hono's default 404 rather than throw.
  app.notFound(async (c) => {
    if (!c.env?.ASSETS) return new Response("404 not found", { status: 404 });

    // `etag()` above (mounted on "*") mutates the outgoing response's headers, but a
    // Response straight off `ASSETS.fetch()` ships immutable headers — re-wrap it so a
    // static-asset request goes through the same middleware chain as any other GET.
    const assetRes = await c.env.ASSETS.fetch(c.req.raw);
    return new Response(assetRes.body, assetRes);
  });

  // Without this, an unhandled throw — the ServerDO stub failing, a D1 error — becomes Hono's
  // default plain-text 500, which is neither the documented error shape nor traceable to a
  // route. HTTPException (csrf, body limit) keeps its own response.
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();

    console.error(`unhandled error on ${c.req.method} ${c.req.routePath}`, {
      params: c.req.param(),
      error: err,
    });

    return c.json({ error: "internal error" }, 500);
  });

  app.doc("/doc", {
    openapi: "3.1.0",
    info: { title: "cockpit plane", version: "0.0.0" },
  });

  return app;
}
