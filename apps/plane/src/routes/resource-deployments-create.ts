import { createRoute, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import type { AppRouteHandler } from "../app";
import { db, deployments, projects, resources } from "../db";
import { AppConfigurationSchema } from "../kinds/app";
import { DeploymentSchema, ErrorResponse } from "../schema";
import { deploymentResponse } from "./entity-response";

const CreateDeploymentBody = z
  .object({
    trigger: z
      .object({
        kind: z.literal("manual"),
        commit: z.string().trim().min(1).nullable(),
      })
      .strict(),
  })
  .strict();

export const createResourceDeploymentRoute = createRoute({
  method: "post",
  path: "/resources/{id}/deployments",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      required: true,
      content: { "application/json": { schema: CreateDeploymentBody } },
    },
  },
  responses: {
    201: {
      description: "Queued deployment created without an approval step or execution",
      content: {
        "application/json": { schema: z.object({ deployment: DeploymentSchema }) },
      },
    },
    400: {
      description: "The manual trigger does not match the app source",
      content: { "application/json": { schema: ErrorResponse } },
    },
    404: { description: "No such resource" },
    409: {
      description: "The resource is not a valid project-owned app",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

export const createResourceDeploymentHandler: AppRouteHandler<
  typeof createResourceDeploymentRoute
> = async (c) => {
  const { id } = c.req.valid("param");
  const { trigger } = c.req.valid("json");
  const database = db(c.env.DB);
  const app = await database.select().from(resources).where(eq(resources.id, id)).get();

  if (!app) return c.body(null, 404);

  if (app.kind !== "app" || !app.serverId || !app.projectId) {
    return c.json({ error: "deployments require a project-owned app resource" }, 409);
  }

  const project = await database
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, app.projectId), eq(projects.serverId, app.serverId)))
    .get();

  if (!project) {
    return c.json({ error: "the app project does not belong to the app server" }, 409);
  }

  const configuration = AppConfigurationSchema.safeParse(app.configuration);

  if (!configuration.success) {
    return c.json({ error: "the app has invalid saved configuration" }, 409);
  }

  let sourceRevision: { ref: string; commit: string; message: null } | null;

  if (configuration.data.source.type === "repo") {

    if (trigger.commit === null) {
      return c.json({ error: "manual repository deployments require a commit" }, 400);
    }

    sourceRevision = {
      ref: configuration.data.source.ref,
      commit: trigger.commit,
      message: null,
    };
  } else {

    if (trigger.commit !== null) {
      return c.json({ error: "manual image deployments do not accept a commit" }, 400);
    }

    sourceRevision = null;
  }

  const now = c.var.deps.clock.now();
  const deployment = {
    id: c.var.deps.ids.id("dep"),
    projectId: app.projectId,
    appId: app.id,
    serverId: app.serverId,
    trigger,
    // Authentication is not wired yet. app.ts documents this single operator identity.
    triggeredBy: { kind: "human" as const, id: "operator" },
    status: "queued",
    sourceRevision,
    configurationSnapshot: structuredClone(app.configuration),
    configurationVersion: app.configurationVersion,
    steps: [],
    changes: null,
    // The record reserves its workflow identity. This API slice starts no Workflow.
    workflowId: c.var.deps.ids.id("wf"),
    releaseId: null,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
  };

  await database.insert(deployments).values(deployment);

  return c.json({ deployment: deploymentResponse(deployment) }, 201);
};
