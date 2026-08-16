import { createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import type { AppRouteHandler } from "../app";
import { db, isUniqueConstraintError, projects, servers, sources } from "../db";
import {
  ErrorResponse,
  ProjectSchema,
  ProjectSettingsSchema,
  ProjectSourceBinding,
} from "../schema";
import { projectResponse } from "./entity-response";

// ADR-0012: importing a repository is how a Project is created. Unlike POST /projects, the
// whole source binding is required — a Project without one cannot be deployed.
const ImportProjectBody = z
  .object({
    server_id: z.string().min(1),
    name: z.string().min(1),
    ...ProjectSourceBinding,
    settings: ProjectSettingsSchema,
  })
  .strict();

const ProjectResponse = z.object({ project: ProjectSchema });

export const importProjectRoute = createRoute({
  method: "post",
  path: "/projects/import",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: ImportProjectBody } },
    },
  },
  responses: {
    201: {
      description: "Project imported",
      content: { "application/json": { schema: ProjectResponse } },
    },
    400: {
      description: "Invalid project",
      content: { "application/json": { schema: ErrorResponse } },
    },
    404: {
      description: "No such server or source",
      content: { "application/json": { schema: ErrorResponse } },
    },
    409: {
      description: "The name or the repository stack is already taken on this server",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

export const importProjectHandler: AppRouteHandler<typeof importProjectRoute> = async (c) => {
  const body = c.req.valid("json");
  const database = db(c.env.DB);
  const [server, source] = await Promise.all([
    database.select({ id: servers.id }).from(servers).where(eq(servers.id, body.server_id)).get(),
    database.select({ id: sources.id }).from(sources).where(eq(sources.id, body.source_id)).get(),
  ]);

  if (!server) return c.json({ error: "no such server" }, 404);
  if (!source) return c.json({ error: "no such source" }, 404);

  const now = c.var.deps.clock.now();
  const project = {
    id: c.var.deps.ids.id("prj"),
    serverId: body.server_id,
    name: body.name,
    sourceId: body.source_id,
    repositoryId: body.repository_id,
    repositoryFullName: body.repository_full_name,
    ref: body.ref,
    baseDirectory: body.base_directory,
    composePath: body.compose_path,
    autoDeploy: body.auto_deploy,
    settings: body.settings,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await database.insert(projects).values(project);
  } catch (error) {
    if (isUniqueConstraintError(error, "projects.name")) {
      return c.json({ error: "a project with this name already exists on the server" }, 409);
    }

    if (isUniqueConstraintError(error, "projects.compose_path")) {
      return c.json({ error: "this repository stack is already imported on the server" }, 409);
    }

    throw error;
  }

  return c.json({ project: projectResponse(project) }, 201);
};
