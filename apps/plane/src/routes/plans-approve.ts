// POST /plans/{id}/approve — pending -> approved.
//
// Approval does NOT execute. `POST /plans/{id}/apply` starts the Workflow and is the next
// slice (type-design §4); keeping the two acts separate is what makes "a plan is the dry run"
// true rather than a matter of timing (ADR-0003).

import { createRoute, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { AppRouteHandler } from "../app";
import { db, plans } from "../db";
import { OPERATOR, parsePlanRow } from "../plan/row";
import { ErrorResponse, PlanResponse } from "../schema";

export const approvePlanRoute = createRoute({
  method: "post",
  path: "/plans/{id}/approve",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Plan approved; nothing has been executed",
      content: { "application/json": { schema: PlanResponse } },
    },
    404: { description: "No such plan" },
    409: {
      description: "Plan is not pending",
      content: { "application/json": { schema: ErrorResponse } },
    },
    500: {
      description: "The stored plan record is corrupt; it cannot be read, so it cannot be approved",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

export const approvePlanHandler: AppRouteHandler<typeof approvePlanRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const deps = c.var.deps;
  const database = db(c.env.DB);

  const row = await database.select().from(plans).where(eq(plans.id, id)).get();
  if (!row) return c.body(null, 404);

  // Refuse before touching it: approving a plan whose changes cannot be read is approving
  // something nobody — operator or agent — was able to review.
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
  // `status = 'pending'` in the WHERE, not just in the check above: two concurrent approvals
  // otherwise both read pending and both write, and the second silently re-stamps the first.
  const updated = await database
    .update(plans)
    .set({ status: "approved", decidedAt: now, approvedAt: now, actor })
    .where(and(eq(plans.id, id), eq(plans.status, "pending")));
  if (updated.meta.changes === 0) return c.json({ error: "plan is no longer pending" }, 409);

  return c.json({
    plan: {
      ...result.plan,
      status: "approved" as const,
      decided_by: OPERATOR,
      decided_at: now,
      approved_at: now,
    },
  });
};
