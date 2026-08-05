import { createRoute, z } from "@hono/zod-openapi";
import type { AppRouteHandler } from "../app";
import { db, servers } from "../db";
import { ServerSchema } from "../schema";
import { safeJsonParse } from "../json";

export const listServersRoute = createRoute({
  method: "get",
  path: "/servers",
  responses: {
    200: {
      description: "All servers, with connection status",
      content: { "application/json": { schema: z.object({ servers: z.array(ServerSchema) }) } },
    },
  },
});

export const listServersHandler: AppRouteHandler<typeof listServersRoute> = async (c) => {
  const rows = await db(c.env.DB).select().from(servers).all();

  return c.json({
    servers: rows.map((row) => ({
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
    })),
  });
};
