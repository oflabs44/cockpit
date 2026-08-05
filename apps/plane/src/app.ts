import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { csrf } from "hono/csrf";
import { bodyLimit } from "hono/body-limit";
import { etag } from "hono/etag";
import type { Env } from "./env";
import type { Deps } from "./deps";
import { realDeps } from "./deps";

export type Bindings = Env;
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
  const app = new OpenAPIHono<{ Bindings: Bindings; Variables: Variables }>();

  app.use("*", requestId());
  app.use("*", secureHeaders());
  // No `cors()` — the web UI, MCP server, and daemon WS endpoint all live on this one
  // Worker (docs/architecture.md §2.1: "one Worker"), so every call is same-origin by
  // construction. Adding cors() would quietly permit cross-origin calls that the
  // single-Worker deploy exists to make unnecessary — never add it back.
  app.use("*", bodyLimit({ maxSize: 1 * 1024 * 1024 })); // 1mb; no route needs more yet
  // csrf() only inspects state-changing methods (POST/PUT/PATCH/DELETE) and passes GET/HEAD
  // through untouched, so mounting it on "*" already matches "csrf on mutating routes"
  // (docs/architecture.md §2.1) without a per-route split.
  app.use("*", csrf());
  app.use("*", etag()); // for polled reads; every route here is a read for now

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
