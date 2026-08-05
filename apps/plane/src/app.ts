import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { csrf } from "hono/csrf";
import { bodyLimit } from "hono/body-limit";
import { etag } from "hono/etag";
import type { Deps } from "./deps";
import { realDeps } from "./deps";

export type Variables = { deps: Deps };

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  responses: {
    200: {
      description: "Proof of life",
      content: {
        "application/json": {
          schema: z.object({ status: z.literal("ok") }),
        },
      },
    },
  },
});

/**
 * App factory: `deps` (clock, id generation) is injected rather than reached for as a
 * global, per docs/type-design.md §1 — no `Date.now()`/`Math.random()` in plane logic.
 */
export function createApp(deps: Deps = realDeps) {
  const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

  app.use("*", requestId({ generator: () => deps.ids.id("req") }));
  app.use("*", secureHeaders());
  // No `cors()`: Hono's `csrf()` below only inspects form-encoded/multipart/text-plain bodies
  // (it checks Content-Type, not method) and lets `application/json` requests through
  // regardless of origin. The absence of `cors()` is therefore the ONLY thing stopping a
  // cross-origin page from POSTing JSON to this Worker today — adding `cors()` back would
  // silently remove that defence, not just permit reads.
  app.use("*", bodyLimit({ maxSize: 1 * 1024 * 1024 })); // 1mb; no route needs more yet
  // csrf() only inspects state-changing methods (POST/PUT/PATCH/DELETE) and passes GET/HEAD
  // through untouched, so mounting it on "*" already matches "csrf on mutating routes"
  // (docs/architecture.md §2.1) without a per-route split.
  app.use("*", csrf());
  // Scoped to GET/HEAD: etag hashes the body to produce a cache-validation header, which is
  // meaningless (and wasteful) on errors and on mutating responses once those exist.
  app.use("*", async (c, next) => {
    if (c.req.method === "GET" || c.req.method === "HEAD") return etag()(c, next);
    return next();
  });

  app.use("*", async (c, next) => {
    c.set("deps", deps);
    await next();
  });

  app.openapi(healthRoute, (c) => c.json({ status: "ok" as const }));

  app.doc("/doc", {
    openapi: "3.1.0",
    info: { title: "cockpit plane", version: "0.0.0" },
  });

  return app;
}
