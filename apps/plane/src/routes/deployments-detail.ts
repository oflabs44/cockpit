import { createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import type { AppRouteHandler } from "../app";
import { db, deployments } from "../db";
import { DeploymentSchema } from "../schema";
import { deploymentResponse } from "./entity-response";

export const getDeploymentRoute = createRoute({
  method: "get",
  path: "/deployments/{id}",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "Deployment detail",
      content: {
        "application/json": { schema: z.object({ deployment: DeploymentSchema }) },
      },
    },
    404: { description: "No such deployment" },
  },
});

export const getDeploymentHandler: AppRouteHandler<typeof getDeploymentRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const row = await db(c.env.DB).select().from(deployments).where(eq(deployments.id, id)).get();

  if (!row) return c.body(null, 404);

  return c.json({ deployment: deploymentResponse(row) });
};
