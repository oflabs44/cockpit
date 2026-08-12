import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  DeploymentSchema,
  EventSchema,
  OperationSchema,
  ProjectSchema,
  ReleaseSchema,
  ResourceSchema,
} from "../src/schema";
import { db, deployments, events, operations, projects, releases, resources, servers } from "../src/db";

const NOW = 1_700_000_000_000;
const ACTOR = { kind: "human" as const, id: "operator" };
const CONFIGURATION = { image: "ghcr.io/oflabs44/jerry:1" };

describe("ADR-0009 public model", () => {
  it("exports the project and resource configuration model", () => {
    expect(
      ProjectSchema.parse({
        id: "prj_1",
        server_id: "srv_1",
        name: "jerry",
        created_at: NOW,
        updated_at: NOW,
      }),
    ).toMatchObject({ id: "prj_1", server_id: "srv_1" });

    expect(
      ResourceSchema.parse({
        id: "res_1",
        server_id: "srv_1",
        project_id: "prj_1",
        kind: "app",
        name: "jerry",
        configuration: CONFIGURATION,
        configuration_version: 1,
        current_release_id: null,
        health: "unknown",
        exposed_at: null,
        drifted: false,
        observed: null,
        observed_rev: 0,
        observed_at: null,
        created_at: NOW,
        updated_at: NOW,
      }),
    ).toMatchObject({ configuration: CONFIGURATION, configuration_version: 1 });

    const app = {
      id: "res_1",
      server_id: "srv_1",
      project_id: "prj_1",
      kind: "app" as const,
      name: "jerry",
      configuration: CONFIGURATION,
      configuration_version: 1,
      current_release_id: null,
      health: "unknown" as const,
      exposed_at: null,
      drifted: false,
      observed: null,
      observed_rev: 0,
      observed_at: null,
      created_at: NOW,
      updated_at: NOW,
    };

    expect(ResourceSchema.safeParse({ ...app, project_id: null }).success).toBe(false);
    expect(ResourceSchema.safeParse({ ...app, server_id: null }).success).toBe(false);
    expect(
      ResourceSchema.safeParse({
        ...app,
        kind: "source",
        server_id: null,
        project_id: null,
      }).success,
    ).toBe(true);
    expect(
      ResourceSchema.safeParse({
        ...app,
        kind: "database",
        server_id: null,
      }).success,
    ).toBe(false);
  });

  it("exports attributable deployments, operations, releases, and events", () => {
    const deployment = DeploymentSchema.parse({
      id: "dep_1",
      project_id: "prj_1",
      app_id: "res_1",
      server_id: "srv_1",
      trigger: { kind: "manual", commit: null },
      triggered_by: ACTOR,
      status: "queued",
      source_revision: null,
      configuration_snapshot: CONFIGURATION,
      configuration_version: 1,
      steps: [],
      changes: null,
      workflow_id: "workflow-dep-1",
      release_id: null,
      created_at: NOW,
      started_at: null,
      finished_at: null,
    });
    expect(deployment.trigger).toEqual({ kind: "manual", commit: null });

    const operation = OperationSchema.parse({
      id: "opn_1",
      server_id: "srv_1",
      project_id: "prj_1",
      resource_id: "res_1",
      kind: "resource.restart",
      actor: ACTOR,
      status: "queued",
      configuration_snapshot: null,
      changes: null,
      workflow_id: null,
      release_id: null,
      created_at: NOW,
      started_at: null,
      finished_at: null,
    });
    expect(operation.actor).toEqual(ACTOR);

    const release = {
      id: "rel_1",
      resource_id: "res_1",
      rev: 1,
      deployment_id: "dep_1",
      operation_id: null,
      configuration_snapshot: CONFIGURATION,
      runtime_snapshot: { image_digest: "sha256:abc" },
      source_revision: null,
      image_digest: "sha256:abc",
      restored_from_release_id: null,
      status: "active" as const,
      created_at: NOW,
    };
    expect(ReleaseSchema.parse(release).status).toBe("active");
    expect(
      ReleaseSchema.safeParse({ ...release, deployment_id: null, operation_id: "opn_1" }).success,
    ).toBe(true);
    expect(
      ReleaseSchema.safeParse({ ...release, deployment_id: null, operation_id: null }).success,
    ).toBe(false);
    expect(
      ReleaseSchema.safeParse({ ...release, operation_id: "opn_1" }).success,
    ).toBe(false);

    expect(
      EventSchema.parse({
        id: "evt_1",
        server_id: "srv_1",
        project_id: "prj_1",
        resource_id: "res_1",
        deployment_id: "dep_1",
        operation_id: null,
        type: "deployment.succeeded",
        actor: ACTOR,
        payload: { release_id: "rel_1" },
        at: NOW,
      }).payload,
    ).toEqual({ release_id: "rel_1" });
  });
});

describe("ADR-0009 persistence", () => {
  it("applies the replacement migration and removes Plan storage", async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string }>();
    const names = tables.results.map(({ name }) => name);

    expect(names).toEqual(
      expect.arrayContaining([
        "deployments",
        "events",
        "operations",
        "projects",
        "releases",
        "resources",
      ]),
    );
    expect(names).not.toContain("plans");

    const columns = await env.DB.prepare("PRAGMA table_info(resources)").all<{ name: string }>();
    const columnNames = columns.results.map(({ name }) => name);
    expect(columnNames).toEqual(
      expect.arrayContaining([
        "configuration",
        "configuration_version",
        "current_release_id",
      ]),
    );
    expect(columnNames).not.toContain("spec");

    const definitions = await env.DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('resources', 'releases')",
    ).all<{ name: string; sql: string }>();
    const resourceSql = definitions.results.find(({ name }) => name === "resources")?.sql;
    const releaseSql = definitions.results.find(({ name }) => name === "releases")?.sql;
    expect(resourceSql).toContain("resources_app_ownership");
    expect(resourceSql).toContain("resources_project_ownership");
    expect(releaseSql).toContain("releases_one_origin");
    expect(releaseSql).toContain("releases_status");

    const indexes = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index'",
    ).all<{ name: string }>();
    expect(indexes.results.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "idx_projects_id_server",
        "idx_resources_ownership",
        "idx_releases_one_active",
      ]),
    );
  });

  it("stores one owned deployment graph with typed JSON fields", async () => {
    const database = db(env.DB);

    await database.insert(servers).values({
      id: "srv_model",
      name: "model-server",
      provider: "hetzner",
      labels: "{}",
      createdAt: NOW,
    });
    await database.insert(projects).values({
      id: "prj_model",
      serverId: "srv_model",
      name: "jerry",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await database.insert(servers).values({
      id: "srv_other_model",
      name: "other-model-server",
      provider: "hetzner",
      labels: "{}",
      createdAt: NOW,
    });
    await database.insert(projects).values({
      id: "prj_other_model",
      serverId: "srv_other_model",
      name: "jerry",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await expect(
      database.insert(resources).values({
        id: "res_cross_server",
        serverId: "srv_model",
        projectId: "prj_other_model",
        kind: "database",
        name: "cross-server",
        configuration: {},
        configurationVersion: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).rejects.toThrow();
    await expect(
      database.insert(resources).values({
        id: "res_unowned_app",
        serverId: "srv_model",
        kind: "app",
        name: "unowned",
        configuration: CONFIGURATION,
        configurationVersion: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).rejects.toThrow();

    await expect(
      database.insert(resources).values({
        id: "res_serverless_app",
        projectId: "prj_model",
        kind: "app",
        name: "serverless",
        configuration: CONFIGURATION,
        configurationVersion: 1,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ).rejects.toThrow();

    await database.insert(resources).values({
      id: "res_model",
      serverId: "srv_model",
      projectId: "prj_model",
      kind: "app",
      name: "jerry",
      configuration: CONFIGURATION,
      configurationVersion: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const deploymentValues = {
      trigger: { kind: "manual" as const, commit: null },
      triggeredBy: ACTOR,
      status: "succeeded",
      configurationSnapshot: CONFIGURATION,
      configurationVersion: 1,
      steps: [],
      createdAt: NOW,
      startedAt: NOW,
      finishedAt: NOW + 1,
    };
    await expect(
      database.insert(deployments).values({
        ...deploymentValues,
        id: "dep_cross_project",
        projectId: "prj_other_model",
        appId: "res_model",
        serverId: "srv_other_model",
        workflowId: "workflow-cross-project",
      }),
    ).rejects.toThrow();
    await expect(
      database.insert(deployments).values({
        ...deploymentValues,
        id: "dep_cross_server",
        projectId: "prj_model",
        appId: "res_model",
        serverId: "srv_other_model",
        workflowId: "workflow-cross-server",
      }),
    ).rejects.toThrow();
    await database.insert(deployments).values({
      ...deploymentValues,
      id: "dep_model",
      projectId: "prj_model",
      appId: "res_model",
      serverId: "srv_model",
      workflowId: "workflow-model",
    });
    await database.insert(operations).values({
      id: "opn_model",
      serverId: "srv_model",
      projectId: "prj_model",
      resourceId: "res_model",
      kind: "resource.apply",
      actor: ACTOR,
      status: "succeeded",
      configurationSnapshot: CONFIGURATION,
      createdAt: NOW,
      startedAt: NOW,
      finishedAt: NOW + 1,
    });
    await expect(
      database.insert(releases).values({
        id: "rel_without_origin",
        resourceId: "res_model",
        rev: 1,
        configurationSnapshot: CONFIGURATION,
        runtimeSnapshot: {},
        status: "active",
        createdAt: NOW + 1,
      }),
    ).rejects.toThrow();
    await expect(
      database.insert(releases).values({
        id: "rel_with_two_origins",
        resourceId: "res_model",
        rev: 1,
        deploymentId: "dep_model",
        operationId: "opn_model",
        configurationSnapshot: CONFIGURATION,
        runtimeSnapshot: {},
        status: "active",
        createdAt: NOW + 1,
      }),
    ).rejects.toThrow();

    await database.insert(releases).values({
      id: "rel_operation_model",
      resourceId: "res_model",
      rev: 2,
      operationId: "opn_model",
      configurationSnapshot: CONFIGURATION,
      runtimeSnapshot: {},
      status: "superseded",
      createdAt: NOW + 1,
    });
    await database.insert(releases).values({
      id: "rel_model",
      resourceId: "res_model",
      rev: 1,
      deploymentId: "dep_model",
      configurationSnapshot: CONFIGURATION,
      runtimeSnapshot: { image_digest: "sha256:abc" },
      status: "active",
      createdAt: NOW + 1,
    });
    await expect(
      database.insert(releases).values({
        id: "rel_second_active",
        resourceId: "res_model",
        rev: 3,
        operationId: "opn_model",
        configurationSnapshot: CONFIGURATION,
        runtimeSnapshot: {},
        status: "active",
        createdAt: NOW + 2,
      }),
    ).rejects.toThrow();
    await database
      .update(resources)
      .set({ currentReleaseId: "rel_model" })
      .where(eq(resources.id, "res_model"));
    await database
      .update(deployments)
      .set({ releaseId: "rel_model" })
      .where(eq(deployments.id, "dep_model"));
    await database.insert(events).values({
      id: "evt_model",
      serverId: "srv_model",
      projectId: "prj_model",
      resourceId: "res_model",
      deploymentId: "dep_model",
      type: "deployment.succeeded",
      actor: ACTOR,
      payload: { release_id: "rel_model" },
      at: NOW + 1,
    });

    const [resource] = await database
      .select()
      .from(resources)
      .where(eq(resources.id, "res_model"));
    const [deployment] = await database
      .select()
      .from(deployments)
      .where(eq(deployments.id, "dep_model"));
    const [operation] = await database
      .select()
      .from(operations)
      .where(eq(operations.id, "opn_model"));
    const [event] = await database.select().from(events).where(eq(events.id, "evt_model"));

    expect(resource?.configuration).toEqual(CONFIGURATION);
    expect(resource?.configurationVersion).toBe(1);
    expect(resource?.currentReleaseId).toBe("rel_model");
    expect(deployment?.trigger).toEqual({ kind: "manual", commit: null });
    expect(operation?.actor).toEqual(ACTOR);
    expect(event?.payload).toEqual({ release_id: "rel_model" });
  });
});
