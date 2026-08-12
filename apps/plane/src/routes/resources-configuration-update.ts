import { createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import type { AppRouteHandler } from "../app";
import { db, resources } from "../db";
import { kindEntry } from "../kinds";
import { ErrorResponse, ResourceSchema } from "../schema";
import { resourceResponse } from "./entity-response";

const SaveConfigurationBody = z
  .object({ configuration: ResourceSchema.shape.configuration })
  .strict();

export const updateResourceConfigurationRoute = createRoute({
  method: "patch",
  path: "/resources/{id}/configuration",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: SaveConfigurationBody } },
    },
  },
  responses: {
    200: {
      description: "Saved configuration updated without changing the server",
      content: {
        "application/json": { schema: z.object({ resource: ResourceSchema }) },
      },
    },
    400: {
      description: "Unsupported resource kind or invalid configuration",
      content: { "application/json": { schema: ErrorResponse } },
    },
    404: { description: "No such resource" },
  },
});

export const updateResourceConfigurationHandler: AppRouteHandler<
  typeof updateResourceConfigurationRoute
> = async (c) => {
  const { id } = c.req.valid("param");
  const { configuration } = c.req.valid("json");
  const database = db(c.env.DB);
  const resource = await database.select().from(resources).where(eq(resources.id, id)).get();

  if (!resource) return c.body(null, 404);

  const entry = kindEntry(resource.kind);

  if (!entry) return c.json({ error: `unsupported resource kind: ${resource.kind}` }, 400);

  const parsed = entry.configurationSchema.safeParse(configuration);

  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

  const savedConfiguration = parsed.data as Record<string, unknown>;
  const updatedAt = c.var.deps.clock.now();
  await database
    .update(resources)
    .set({
      configuration: savedConfiguration,
      configurationVersion: entry.configurationVersion,
      updatedAt,
    })
    .where(eq(resources.id, id));

  return c.json({
    resource: resourceResponse({
      ...resource,
      configuration: savedConfiguration,
      configurationVersion: entry.configurationVersion,
      updatedAt,
    }),
  });
};
