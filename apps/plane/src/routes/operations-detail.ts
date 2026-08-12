import { createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import type { AppRouteHandler } from "../app";
import { db, operations } from "../db";
import { OperationSchema } from "../schema";
import { operationResponse } from "./entity-response";

export const getOperationRoute = createRoute({
  method: "get",
  path: "/operations/{id}",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Operation detail",
      content: {
        "application/json": { schema: z.object({ operation: OperationSchema }) },
      },
    },
    404: { description: "No such operation" },
  },
});

export const getOperationHandler: AppRouteHandler<typeof getOperationRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const row = await db(c.env.DB).select().from(operations).where(eq(operations.id, id)).get();

  if (!row) return c.body(null, 404);

  return c.json({ operation: operationResponse(row) });
};
