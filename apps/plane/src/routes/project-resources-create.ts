import { createRoute, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { AppRouteHandler } from "../app";
import { db, isUniqueConstraintError, projects, resources } from "../db";
import { kindEntry } from "../kinds";
import { ErrorResponse, ResourceSchema } from "../schema";
import { resourceResponse } from "./entity-response";

const CreateProjectResourceBody = z
  .object({
    name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    kind: ResourceSchema.shape.kind,
    configuration: ResourceSchema.shape.configuration,
  })
  .strict();

export const createProjectResourceRoute = createRoute({
  method: "post",
  path: "/projects/{id}/resources",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: CreateProjectResourceBody } },
    },
  },
  responses: {
    201: {
      description: "Project-owned server resource created without changing the server",
      content: {
        "application/json": { schema: z.object({ resource: ResourceSchema }) },
      },
    },
    400: {
      description: "Unsupported kind, invalid name, or invalid configuration",
      content: { "application/json": { schema: ErrorResponse } },
    },
    404: { description: "No such project" },
    409: {
      description: "The server already has a resource with this kind and name",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

export const createProjectResourceHandler: AppRouteHandler<
  typeof createProjectResourceRoute
> = async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  const database = db(c.env.DB);
  const project = await database.select().from(projects).where(eq(projects.id, id)).get();

  if (!project) return c.body(null, 404);

  const entry = kindEntry(body.kind);

  if (!entry) return c.json({ error: `unsupported project resource kind: ${body.kind}` }, 400);

  const parsed = entry.configurationSchema.safeParse(body.configuration);

  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

  const existing = await database
    .select({ id: resources.id })
    .from(resources)
    .where(
      and(
        eq(resources.serverId, project.serverId),
        eq(resources.kind, body.kind),
        eq(resources.name, body.name),
      ),
    )
    .get();

  if (existing) {
    return c.json({ error: "resource kind and name already exist on this server" }, 409);
  }

  const now = c.var.deps.clock.now();
  const resource = {
    id: c.var.deps.ids.id("res"),
    serverId: project.serverId,
    projectId: project.id,
    kind: body.kind,
    name: body.name,
    configuration: parsed.data as Record<string, unknown>,
    configurationVersion: entry.configurationVersion,
    currentReleaseId: null,
    health: "unknown",
    exposedAt: null,
    drifted: false,
    observed: null,
    observedRev: 0,
    observedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await database.insert(resources).values(resource);
  } catch (error) {
    const duplicate = isUniqueConstraintError(error, "idx_resources_identity");

    if (duplicate) {
      return c.json({ error: "resource kind and name already exist on this server" }, 409);
    }

    throw error;
  }

  return c.json({ resource: resourceResponse(resource) }, 201);
};
