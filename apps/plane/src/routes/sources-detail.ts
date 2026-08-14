import { createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import type { AppRouteHandler } from "../app";
import { db, sources } from "../db";
import { SourceSchema } from "../schema";
import { sourceResponse } from "./entity-response";

export const getSourceRoute = createRoute({
  method: "get",
  path: "/source-connections/{id}",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Source detail",
      content: { "application/json": { schema: z.object({ source: SourceSchema }) } },
    },
    404: { description: "No such source" },
  },
});

export const getSourceHandler: AppRouteHandler<typeof getSourceRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const row = await db(c.env.DB).select().from(sources).where(eq(sources.id, id)).get();
  if (!row) return c.body(null, 404);

  return c.json({ source: sourceResponse(row) });
};
