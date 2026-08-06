// GET /plans — the proposal queue. Filterable by status and server (type-design §4 also lists
// actor; there is one actor until auth exists, so that filter waits for it).

import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, desc } from "drizzle-orm";
import type { AppRouteHandler } from "../app";
import { db, plans } from "../db";
import { corruptPlan, parsePlanRow } from "../plan/row";
import { PlanListResponse, PlanStatus } from "../schema";

export const listPlansRoute = createRoute({
  method: "get",
  path: "/plans",
  request: {
    query: z.object({
      status: PlanStatus.optional(),
      server: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Plans, newest first",
      content: { "application/json": { schema: PlanListResponse } },
    },
  },
});

export const listPlansHandler: AppRouteHandler<typeof listPlansRoute> = async (c) => {
  const { status, server } = c.req.valid("query");
  const filters = [
    ...(status ? [eq(plans.status, status)] : []),
    ...(server ? [eq(plans.serverId, server)] : []),
  ];

  const rows = await db(c.env.DB)
    .select()
    .from(plans)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(plans.createdAt))
    .all();

  // A corrupt row is marked, not skipped and not defaulted: dropping it hides that the audit
  // log lost a record, and defaulting it would invent an empty plan attributed to someone.
  return c.json({
    plans: rows.map((row) => {
      const result = parsePlanRow(row);
      if (result.ok) return result.plan;

      console.error(`corrupt plan ${row.id}: ${result.corruption}`);

      return corruptPlan(row, result.corruption);
    }),
  });
};
