import { eq } from "drizzle-orm";
import type { Context } from "hono";
import type { AppEnv } from "../app";
import { db, deployments } from "../db";
import { streamName } from "../durable-objects/stream-do";

// WS GET /deployments/{id}/logs — the browser half of docs/architecture.md §3.4.
//
// Not an OpenAPI route: a 101 upgrade has no JSON body to describe, and `createRoute` would
// document a response this never returns. It is registered like `/daemon` — but unlike
// `/daemon` it sits *behind* Access (src/app.ts), because the caller is an operator's
// browser, not a daemon holding a per-server credential.
//
// The deployment is resolved in D1 before any Durable Object is addressed. `idFromName` on
// an unvalidated path segment would let anyone conjure a StreamDO for an id that does not
// exist and sit on it — cheap, but it is a namespace of objects created by strangers.
export async function deploymentLogsHandler(c: Context<AppEnv>) {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return c.text("expected websocket", 426);
  }

  const id = c.req.param("id") ?? "";
  const deployment = await db(c.env.DB).select().from(deployments).where(eq(deployments.id, id)).get();
  if (!deployment) return c.text("no such deployment", 404);

  const stub = c.env.STREAM_DO.get(c.env.STREAM_DO.idFromName(streamName(deployment.id)));
  const headers = new Headers(c.req.raw.headers);
  // Route-owned: the StreamDO echoes this back on `stream_open`, so a client-supplied value
  // must not survive into it.
  headers.set("x-cockpit-deployment-id", deployment.id);

  // `after` rides along in the URL — the StreamDO reads it to replay only what this
  // subscriber has not already rendered.
  return stub.fetch(new Request(c.req.raw, { headers }));
}
