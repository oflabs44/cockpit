import { createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import type { AppRouteHandler } from "../app";
import { db, servers } from "../db";
import { ServerDetailResponse } from "../schema";
import { safeJsonParse } from "../json";

export const getServerRoute = createRoute({
  method: "get",
  path: "/servers/{id}",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Server detail, including its latest observed snapshot",
      content: { "application/json": { schema: ServerDetailResponse } },
    },
    404: { description: "No such server" },
  },
});

export const getServerHandler: AppRouteHandler<typeof getServerRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const row = await db(c.env.DB).select().from(servers).where(eq(servers.id, id)).get();
  if (!row) return c.body(null, 404);

  const stub = c.env.SERVER_DO.get(c.env.SERVER_DO.idFromName(`server:${id}`));
  const observed = await stub.getSnapshot();

  return c.json({
    server: {
      id: row.id,
      name: row.name,
      provider: row.provider as "hetzner" | "digitalocean" | "linode" | "other",
      addr: row.addr,
      arch: row.arch,
      status: row.status as "enrolling" | "connected" | "disconnected" | "draining",
      agent_version: row.agentVersion,
      last_seen_at: row.lastSeenAt,
      labels: safeJsonParse(row.labels, {}, `servers.labels (${row.id})`),
      created_at: row.createdAt,
    },
    observed: observed ? { rev: observed.rev, resources: observed.resources } : null,
  });
};
