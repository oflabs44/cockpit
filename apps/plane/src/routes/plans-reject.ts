// POST /plans/{id}/reject — pending -> rejected (type-design §2.5).
//
// A rejected plan is dead: it never applies and is never deleted. The record of a proposal
// that was refused, by whom, and when is exactly what the audit log exists for.

import { createRoute, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { AppRouteHandler } from "../app";
import { db, plans } from "../db";
import { OPERATOR, parsePlanRow } from "../plan/row";
import { ErrorResponse, PlanResponse } from "../schema";

export const rejectPlanRoute = createRoute({
  method: "post",
  path: "/plans/{id}/reject",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Plan rejected; terminal",
      content: { "application/json": { schema: PlanResponse } },
    },
    404: { description: "No such plan" },
    409: {
      description: "Plan is not pending",
      content: { "application/json": { schema: ErrorResponse } },
    },
    500: {
      description: "The stored plan record is corrupt and will not be rendered as a safe one",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

export const rejectPlanHandler: AppRouteHandler<typeof rejectPlanRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const deps = c.var.deps;
  const database = db(c.env.DB);

  const row = await database.select().from(plans).where(eq(plans.id, id)).get();
  if (!row) return c.body(null, 404);

  const result = parsePlanRow(row);
  if (!result.ok) {
    console.error(`corrupt plan ${row.id}: ${result.corruption}`);

    return c.json({ error: `plan ${row.id} is corrupt: ${result.corruption}` }, 500);
  }
  if (result.plan.status !== "pending") {
    return c.json({ error: `plan is ${result.plan.status}, not pending` }, 409);
  }

  const now = deps.clock.now();
  const actor = JSON.stringify({ created_by: result.plan.created_by, decided_by: OPERATOR });
  const updated = await database
    .update(plans)
    // `decided_at`, not `approved_at`: the decision is timestamped, but it was not an approval.
    .set({ status: "rejected", decidedAt: now, actor })
    .where(and(eq(plans.id, id), eq(plans.status, "pending")));
  if (updated.meta.changes === 0) return c.json({ error: "plan is no longer pending" }, 409);

  return c.json({
    plan: {
      ...result.plan,
      status: "rejected" as const,
      decided_by: OPERATOR,
      decided_at: now,
    },
  });
};
