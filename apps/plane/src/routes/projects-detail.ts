import { createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import type { AppRouteHandler } from "../app";
import { db, projects } from "../db";
import { ProjectSchema } from "../schema";
import { projectResponse } from "./entity-response";

export const getProjectRoute = createRoute({
  method: "get",
  path: "/projects/{id}",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Project detail",
      content: {
        "application/json": { schema: z.object({ project: ProjectSchema }) },
      },
    },
    404: { description: "No such project" },
  },
});

export const getProjectHandler: AppRouteHandler<typeof getProjectRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const row = await db(c.env.DB).select().from(projects).where(eq(projects.id, id)).get();

  if (!row) return c.body(null, 404);

  return c.json({ project: projectResponse(row) });
};
