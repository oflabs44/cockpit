// GET /servers/{id}/resources — desired state for one server. Observed state lives on
// GET /servers/{id}; the two are deliberately separate reads, because conflating them is how
// a platform starts believing its own intent (#7).

import { createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import type { AppRouteHandler } from "../app";
import { db, resources, servers } from "../db";
import { ResourceListResponse } from "../schema";
import { safeJsonParse } from "../json";

export const listServerResourcesRoute = createRoute({
  method: "get",
  path: "/servers/{id}/resources",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Resources whose desired state is recorded for this server",
      content: { "application/json": { schema: ResourceListResponse } },
    },
    404: { description: "No such server" },
  },
});

export const listServerResourcesHandler: AppRouteHandler<
  typeof listServerResourcesRoute
> = async (c) => {
  const { id } = c.req.valid("param");
  const database = db(c.env.DB);

  const server = await database.select().from(servers).where(eq(servers.id, id)).get();
  if (!server) return c.body(null, 404);

  const rows = await database.select().from(resources).where(eq(resources.serverId, id)).all();

  return c.json({
    resources: rows.map((row) => ({
      id: row.id,
      server_id: row.serverId,
      project_id: row.projectId,
      kind: row.kind,
      name: row.name,
      spec: safeJsonParse<Record<string, unknown>>(row.spec, {}, `resources.spec (${row.id})`),
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    })),
  });
};
