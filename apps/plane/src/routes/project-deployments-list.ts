import { createRoute, z } from "@hono/zod-openapi";
import { desc, eq } from "drizzle-orm";
import type { AppRouteHandler } from "../app";
import { db, deployments, projects } from "../db";
import { DeploymentSchema } from "../schema";
import { deploymentResponse } from "./entity-response";

export const listProjectDeploymentsRoute = createRoute({
  method: "get",
  path: "/projects/{id}/deployments",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Deployments from all apps in the project, newest first",
      content: {
        "application/json": {
          schema: z.object({ deployments: z.array(DeploymentSchema) }),
        },
      },
    },
    404: { description: "No such project" },
  },
});

export const listProjectDeploymentsHandler: AppRouteHandler<
  typeof listProjectDeploymentsRoute
> = async (c) => {
  const { id } = c.req.valid("param");
  const database = db(c.env.DB);
  const project = await database
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, id))
    .get();

  if (!project) return c.body(null, 404);

  const rows = await database
    .select()
    .from(deployments)
    .where(eq(deployments.projectId, id))
    .orderBy(desc(deployments.createdAt))
    .all();

  return c.json({ deployments: rows.map(deploymentResponse) });
};
