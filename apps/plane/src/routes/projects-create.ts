import { createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import type { AppRouteHandler } from "../app";
import { db, isUniqueConstraintError, projects, servers } from "../db";
import { ErrorResponse, ProjectSchema } from "../schema";
import { projectResponse } from "./entity-response";

const CreateProjectBody = ProjectSchema.pick({ server_id: true, name: true })
  .extend({ server_id: z.string().min(1), name: z.string().min(1) })
  .strict();

const ProjectResponse = z.object({ project: ProjectSchema });

export const createProjectRoute = createRoute({
  method: "post",
  path: "/projects",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateProjectBody } },
    },
  },
  responses: {
    201: {
      description: "Project created",
      content: { "application/json": { schema: ProjectResponse } },
    },
    400: {
      description: "Invalid project",
      content: { "application/json": { schema: ErrorResponse } },
    },
    404: { description: "No such server" },
    409: { description: "A project with this name already exists on the server" },
  },
});

export const createProjectHandler: AppRouteHandler<typeof createProjectRoute> = async (c) => {
  const body = c.req.valid("json");
  const database = db(c.env.DB);
  const server = await database
    .select({ id: servers.id })
    .from(servers)
    .where(eq(servers.id, body.server_id))
    .get();

  if (!server) return c.body(null, 404);

  const now = c.var.deps.clock.now();
  const project = {
    id: c.var.deps.ids.id("prj"),
    serverId: body.server_id,
    name: body.name,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await database.insert(projects).values(project);
  } catch (error) {
    const duplicate = isUniqueConstraintError(error, "projects.server_id");

    if (duplicate) return c.body(null, 409);

    throw error;
  }

  return c.json({ project: projectResponse(project) }, 201);
};
