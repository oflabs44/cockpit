import { createRoute, z } from "@hono/zod-openapi";
import { and, gt, isNull } from "drizzle-orm";
import type { AppRouteHandler } from "../app";
import { db, enrolments } from "../db";
import { EnrolmentSchema } from "../schema";
import { safeJsonParse } from "../json";

export const listEnrolmentsRoute = createRoute({
  method: "get",
  path: "/enrolments",
  responses: {
    200: {
      description: "Pending enrolments — unconsumed, unexpired tokens and claim codes",
      content: { "application/json": { schema: z.object({ enrolments: z.array(EnrolmentSchema) }) } },
    },
  },
});

export const listEnrolmentsHandler: AppRouteHandler<typeof listEnrolmentsRoute> = async (c) => {
  const now = c.var.deps.clock.now();
  const rows = await db(c.env.DB)
    .select()
    .from(enrolments)
    .where(and(isNull(enrolments.consumedAt), gt(enrolments.expiresAt, now)))
    .all();

  return c.json({
    enrolments: rows.map((row) => ({
      id: row.id,
      server_id: row.serverId,
      mode: row.mode as "token" | "claim_code",
      presented: row.presented
        ? safeJsonParse<{ hostname: string; arch: string; addr: string; agent_version: string } | null>(
            row.presented,
            null,
            `enrolments.presented (${row.id})`,
          )
        : null,
      expires_at: row.expiresAt,
      created_at: row.createdAt,
    })),
  });
};
