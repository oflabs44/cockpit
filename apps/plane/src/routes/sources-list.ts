import { createRoute } from "@hono/zod-openapi";
import { asc } from "drizzle-orm";
import type { AppRouteHandler } from "../app";
import { db, sources } from "../db";
import { SourceListResponse } from "../schema";
import { sourceResponse } from "./entity-response";

export const listSourcesRoute = createRoute({
  method: "get",
  path: "/source-connections",
  responses: {
    200: {
      description: "All connected sources (account-scoped, ADR-0007 — no server filter)",
      content: { "application/json": { schema: SourceListResponse } },
    },
  },
});

export const listSourcesHandler: AppRouteHandler<typeof listSourcesRoute> = async (c) => {
  const rows = await db(c.env.DB).select().from(sources).orderBy(asc(sources.createdAt)).all();

  return c.json({ sources: rows.map((row) => sourceResponse(row, c.env.GITHUB_APP_SLUG ?? null)) });
};
