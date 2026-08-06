// GET /plans/{id} — the reviewable diff. `changes[].before`/`after` are what a client renders.

import { createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import type { AppRouteHandler } from "../app";
import { db, plans } from "../db";
import { parsePlanRow } from "../plan/row";
import { ErrorResponse, PlanResponse } from "../schema";

export const getPlanRoute = createRoute({
  method: "get",
  path: "/plans/{id}",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Plan detail",
      content: { "application/json": { schema: PlanResponse } },
    },
    404: { description: "No such plan" },
    500: {
      description: "The stored plan record is corrupt and will not be rendered as a safe one",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

export const getPlanHandler: AppRouteHandler<typeof getPlanRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const row = await db(c.env.DB).select().from(plans).where(eq(plans.id, id)).get();
  if (!row) return c.body(null, 404);

  const result = parsePlanRow(row);
  if (!result.ok) {
    console.error(`corrupt plan ${row.id}: ${result.corruption}`);

    return c.json({ error: `plan ${row.id} is corrupt: ${result.corruption}` }, 500);
  }

  return c.json({ plan: result.plan });
};
