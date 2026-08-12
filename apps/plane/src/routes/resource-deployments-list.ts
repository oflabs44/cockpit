import { createRoute, z } from "@hono/zod-openapi";
import { desc, eq } from "drizzle-orm";
import type { AppRouteHandler } from "../app";
import { db, deployments, resources } from "../db";
import { DeploymentSchema, ErrorResponse } from "../schema";
import { deploymentResponse } from "./entity-response";

export const listResourceDeploymentsRoute = createRoute({
  method: "get",
  path: "/resources/{id}/deployments",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Deployments for one app resource, newest first",
      content: {
        "application/json": {
          schema: z.object({ deployments: z.array(DeploymentSchema) }),
        },
      },
    },
    404: { description: "No such resource" },
    409: {
      description: "The resource is not an app",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

export const listResourceDeploymentsHandler: AppRouteHandler<
  typeof listResourceDeploymentsRoute
> = async (c) => {
  const { id } = c.req.valid("param");
  const database = db(c.env.DB);
  const resource = await database.select().from(resources).where(eq(resources.id, id)).get();

  if (!resource) return c.body(null, 404);

  if (resource.kind !== "app") {
    return c.json({ error: "deployments require an app resource" }, 409);
  }

  const rows = await database
    .select()
    .from(deployments)
    .where(eq(deployments.appId, id))
    .orderBy(desc(deployments.createdAt))
    .all();

  return c.json({ deployments: rows.map(deploymentResponse) });
};
