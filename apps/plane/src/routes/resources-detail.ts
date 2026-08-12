import { createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import type { AppRouteHandler } from "../app";
import { db, resources } from "../db";
import { ResourceSchema } from "../schema";
import { resourceResponse } from "./entity-response";

export const getResourceRoute = createRoute({
  method: "get",
  path: "/resources/{id}",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Resource detail",
      content: {
        "application/json": { schema: z.object({ resource: ResourceSchema }) },
      },
    },
    404: { description: "No such resource" },
  },
});

export const getResourceHandler: AppRouteHandler<typeof getResourceRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const row = await db(c.env.DB).select().from(resources).where(eq(resources.id, id)).get();

  if (!row) return c.body(null, 404);

  return c.json({ resource: resourceResponse(row) });
};
