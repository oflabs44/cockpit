import { createRoute, z } from "@hono/zod-openapi";
import { asc, eq } from "drizzle-orm";
import type { AppRouteHandler } from "../app";
import { db, projects } from "../db";
import { ProjectSchema } from "../schema";
import { projectResponse } from "./entity-response";

export const listProjectsRoute = createRoute({
  method: "get",
  path: "/projects",
  request: { query: z.object({ server: z.string().optional() }) },
  responses: {
    200: {
      description: "Projects, optionally limited to one server",
      content: {
        "application/json": { schema: z.object({ projects: z.array(ProjectSchema) }) },
      },
    },
  },
});

export const listProjectsHandler: AppRouteHandler<typeof listProjectsRoute> = async (c) => {
  const { server } = c.req.valid("query");
  const database = db(c.env.DB);
  const rows = server
    ? await database
        .select()
        .from(projects)
        .where(eq(projects.serverId, server))
        .orderBy(asc(projects.createdAt))
        .all()
    : await database.select().from(projects).orderBy(asc(projects.createdAt)).all();

  return c.json({ projects: rows.map(projectResponse) });
};
