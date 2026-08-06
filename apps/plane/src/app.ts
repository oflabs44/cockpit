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
import { upsertResourceRoute, upsertResourceHandler } from "./routes/resources-upsert";
import {
  listServerResourcesRoute,
  listServerResourcesHandler,
} from "./routes/servers-resources-list";
import { listPlansRoute, listPlansHandler } from "./routes/plans-list";
import { getPlanRoute, getPlanHandler } from "./routes/plans-detail";
import { approvePlanRoute, approvePlanHandler } from "./routes/plans-approve";
import { rejectPlanRoute, rejectPlanHandler } from "./routes/plans-reject";
import { daemonWsHandler } from "./routes/daemon-ws";
import type { ServerDO } from "./durable-objects/server-do";

export type Variables = { deps: Deps };
// `wrangler types` cannot know SERVER_DO's RPC surface, so it generates a bare
// `DurableObjectNamespace`. Declared fresh (not `Omit<Env, ...> & {...}`) rather than derived
// from the generated `Env` — deriving via `Omit` on a binding set that includes a
// `DurableObjectNamespace<ServerDO>` pointing back at `Env` itself sent the RPC `Provider<T>`
// mapped type into "Type instantiation is excessively deep" on every stub call; a plain
// interface breaks the cycle TypeScript was trying to fully resolve.
export interface Bindings {
  DB: D1Database;
  SERVER_DO: DurableObjectNamespace<ServerDO>;
}
export type AppEnv = { Bindings: Bindings; Variables: Variables };

/** Handler type for route files: pairs a `createRoute` definition with its controller. */
export type AppRouteHandler<R extends RouteConfig> = RouteHandler<R, AppEnv>;

/**
 * App factory: `deps` (clock, id generation) is injected rather than reached for as a
 * global, per docs/type-design.md §1 — no `Date.now()`/`Math.random()` in plane logic.
 */
export function createApp(deps: Deps = realDeps) {
  const app = new OpenAPIHono<AppEnv>();

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

  // SECURITY: none of the operator routes below (`/servers*`, `/enrolments*`) authenticate the
  // caller yet. That's deliberate — Cloudflare Access fronts the UI/API in a later slice
  // (docs/architecture.md §2.1's auth row) — but undocumented until now: anyone who can reach
  // this Worker can create servers, list pending enrolments, and redeem claim codes. `/daemon`
  // is exempt from this note; it authenticates the daemon's own secret independently, above.
  app.openapi(healthRoute, healthHandler);
  app.openapi(createServerRoute, createServerHandler);
  app.openapi(listServersRoute, listServersHandler);
  app.openapi(getServerRoute, getServerHandler);
  app.openapi(listEnrolmentsRoute, listEnrolmentsHandler);
  app.openapi(redeemEnrolmentRoute, redeemEnrolmentHandler);
  app.openapi(upsertResourceRoute, upsertResourceHandler);
  app.openapi(listServerResourcesRoute, listServerResourcesHandler);
  app.openapi(listPlansRoute, listPlansHandler);
  app.openapi(getPlanRoute, getPlanHandler);
  app.openapi(approvePlanRoute, approvePlanHandler);
  app.openapi(rejectPlanRoute, rejectPlanHandler);
  app.get("/daemon", daemonWsHandler);

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
