import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createApp, type Bindings } from "../src/app";
import { db, deployments, operations, resources } from "../src/db";
import type { Deps } from "../src/deps";

const NOW = 1_700_000_000_000;
const CONFIGURATION = {
  source: {
    type: "repo" as const,
    url: "https://github.com/oflabs44/jerry.git",
    ref: "main",
    path: "apps/worker",
  },
  build: {
    dockerfile: "Dockerfile",
    args: { NODE_ENV: "production" },
    limits: { cpu: "2", memory: "1g" },
    prune: { keep_layers: 5 },
  },
  domains: ["jerry.oflabs.dev"],
  ports: [{ container: 8080, protocol: "tcp" as const }],
  env: { DATABASE_URL: "op://cockpit/jerry/DATABASE_URL" },
  replicas: 1,
  healthcheck: { path: "/health", interval_s: 10, timeout_s: 2, retries: 3 },
  limits: { cpu: "1", memory: "512m" },
  restart: "unless-stopped" as const,
};

const IMAGE_CONFIGURATION = {
  source: { type: "image" as const, image: "ghcr.io/oflabs44/jerry:1" },
  domains: CONFIGURATION.domains,
  ports: CONFIGURATION.ports,
  env: CONFIGURATION.env,
  replicas: CONFIGURATION.replicas,
  healthcheck: CONFIGURATION.healthcheck,
  limits: CONFIGURATION.limits,
  restart: CONFIGURATION.restart,
};

let idCounter = 0;

function testDeps(): Deps {
  return {
    clock: { now: () => NOW },
    ids: { id: (prefix) => `${prefix}_api${idCounter++}` },
  };
}

type App = ReturnType<typeof createApp>;

function jsonRequest(path: string, method: "POST" | "PATCH", body: unknown) {
  return new Request(`http://plane.test${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createServer(app: App, name: string) {
  const response = await app.fetch(
    jsonRequest("/servers", "POST", { name, provider: "hetzner", labels: {} }),
    env,
  );
  expect(response.status).toBe(201);

  return (await response.json()) as { server: { id: string } };
}

async function createProject(app: App, serverId: string, name: string) {
  const response = await app.fetch(
    jsonRequest("/projects", "POST", { server_id: serverId, name }),
    env,
  );
  expect(response.status).toBe(201);

  return (await response.json()) as {
    project: { id: string; server_id: string; name: string; created_at: number; updated_at: number };
  };
}

function createProjectResource(
  app: App,
  projectId: string,
  body: { name: string; kind: string; configuration: unknown },
  bindings: Bindings = env as unknown as Bindings,
) {

  return app.fetch(jsonRequest(`/projects/${projectId}/resources`, "POST", body), bindings);
}

function noDaemonBindings(message: string): Bindings {

  return {
    ...(env as unknown as Bindings),
    SERVER_DO: new Proxy(
      {},
      {
        get() {
          throw new Error(message);
        },
      },
    ) as Bindings["SERVER_DO"],
  };
}

async function insertResource(
  serverId: string,
  projectId: string | null,
  kind = "app",
  configuration: Record<string, unknown> = CONFIGURATION,
) {
  const id = `res_fixture_${idCounter++}`;
  await db(env.DB).insert(resources).values({
    id,
    serverId,
    projectId,
    kind,
    name: `resource-${idCounter}`,
    configuration,
    configurationVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });

  return id;
}

async function createDeployment(
  app: App,
  appId: string,
  commit: string | null = null,
  bindings: Bindings = env as unknown as Bindings,
) {

  return app.fetch(
    jsonRequest(`/resources/${appId}/deployments`, "POST", {
      trigger: { kind: "manual", commit },
    }),
    bindings,
  );
}

describe("project API", () => {
  it("creates, lists, and fetches server-owned projects", async () => {
    const app = createApp(testDeps());
    const firstServer = await createServer(app, `project-server-${idCounter}`);
    const secondServer = await createServer(app, `project-server-${idCounter}`);
    const first = await createProject(app, firstServer.server.id, "jerry");
    await createProject(app, secondServer.server.id, "jerry");

    expect(first.project).toMatchObject({
      server_id: firstServer.server.id,
      name: "jerry",
      created_at: NOW,
      updated_at: NOW,
    });
    expect(first.project.id).toMatch(/^prj_/);

    const list = await app.fetch(
      new Request(`http://plane.test/projects?server=${firstServer.server.id}`),
      env,
    );
    expect(list.status).toBe(200);
    expect((await list.json()) as unknown).toEqual({ projects: [first.project] });

    const detail = await app.fetch(
      new Request(`http://plane.test/projects/${first.project.id}`),
      env,
    );
    expect(detail.status).toBe(200);
    expect((await detail.json()) as unknown).toEqual({ project: first.project });
  });

  it("reports project ownership and identity errors", async () => {
    const app = createApp(testDeps());
    const server = await createServer(app, `project-errors-${idCounter}`);
    await createProject(app, server.server.id, "jerry");

    const missingServer = await app.fetch(
      jsonRequest("/projects", "POST", { server_id: "srv_missing", name: "x" }),
      env,
    );
    expect(missingServer.status).toBe(404);

    const duplicate = await app.fetch(
      jsonRequest("/projects", "POST", { server_id: server.server.id, name: "jerry" }),
      env,
    );
    expect(duplicate.status).toBe(409);

    const invalid = await app.fetch(
      jsonRequest("/projects", "POST", { server_id: server.server.id, name: "" }),
      env,
    );
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get("content-type")).toContain("application/json");
    expect((await invalid.json()) as unknown).toEqual({ error: expect.any(String) });

    const missingDetail = await app.fetch(
      new Request("http://plane.test/projects/prj_missing"),
      env,
    );
    expect(missingDetail.status).toBe(404);
  });
});

describe("project resource API", () => {
  it("creates versioned project resources without accessing the daemon", async () => {
    const app = createApp(testDeps());
    const server = await createServer(app, `resource-create-${idCounter}`);
    const { project } = await createProject(app, server.server.id, "jerry");
    const bindings = noDaemonBindings("the resource create route accessed the daemon namespace");

    const created = await createProjectResource(
      app,
      project.id,
      { name: "jerry-app", kind: "app", configuration: CONFIGURATION },
      bindings,
    );
    expect(created.status).toBe(201);
    expect(created.headers.get("content-type")).toContain("application/json");
    const body = (await created.json()) as {
      resource: {
        id: string;
        server_id: string;
        project_id: string;
        kind: string;
        configuration: unknown;
        configuration_version: number;
      };
    };
    expect(body.resource).toMatchObject({
      server_id: server.server.id,
      project_id: project.id,
      kind: "app",
      configuration: CONFIGURATION,
      configuration_version: 1,
    });

    const database = await createProjectResource(
      app,
      project.id,
      { name: "jerry-db", kind: "database", configuration: { engine: "postgres" } },
      bindings,
    );
    expect(database.status).toBe(201);
    expect(
      ((await database.json()) as { resource: { configuration_version: number } }).resource
        .configuration_version,
    ).toBe(1);
  });

  it("rejects invalid, unsupported, duplicate, and unowned project resources", async () => {
    const app = createApp(testDeps());
    const server = await createServer(app, `resource-create-errors-${idCounter}`);
    const { project } = await createProject(app, server.server.id, "jerry");

    const invalidName = await createProjectResource(app, project.id, {
      name: "Invalid Name",
      kind: "app",
      configuration: CONFIGURATION,
    });
    expect(invalidName.status).toBe(400);
    expect(invalidName.headers.get("content-type")).toContain("application/json");
    expect((await invalidName.json()) as unknown).toEqual({ error: expect.any(String) });
    expect(
      (
        await createProjectResource(app, project.id, {
          name: "invalid-app",
          kind: "app",
          configuration: { source: { type: "repo", url: "x", ref: "main" } },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await createProjectResource(app, project.id, {
          name: "account-domain",
          kind: "domain",
          configuration: {},
        })
      ).status,
    ).toBe(400);

    const first = await createProjectResource(app, project.id, {
      name: "duplicate-app",
      kind: "app",
      configuration: CONFIGURATION,
    });
    expect(first.status).toBe(201);
    expect(
      (
        await createProjectResource(app, project.id, {
          name: "duplicate-app",
          kind: "app",
          configuration: CONFIGURATION,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await createProjectResource(app, "prj_missing", {
          name: "missing-project",
          kind: "app",
          configuration: CONFIGURATION,
        })
      ).status,
    ).toBe(404);

    const wrongContentType = await app.fetch(
      new Request(`http://plane.test/projects/${project.id}/resources`, {
        method: "POST",
        headers: { "content-type": "text/plain", origin: "http://plane.test" },
        body: JSON.stringify({
          name: "text-resource",
          kind: "app",
          configuration: CONFIGURATION,
        }),
      }),
      env,
    );
    expect(wrongContentType.status).toBe(400);
    expect(wrongContentType.headers.get("content-type")).toContain("application/json");
  });
});

describe("resource configuration API", () => {
  it("saves validated configuration without accessing the daemon or creating a run", async () => {
    const app = createApp(testDeps());
    const server = await createServer(app, `configuration-server-${idCounter}`);
    const { project } = await createProject(app, server.server.id, "jerry");
    const resourceId = await insertResource(server.server.id, project.id);
    const changed = { ...CONFIGURATION, replicas: 2 };
    const bindings = noDaemonBindings("the configuration route accessed the daemon namespace");
    const response = await app.fetch(
      jsonRequest(`/resources/${resourceId}/configuration`, "PATCH", {
        configuration: changed,
      }),
      bindings,
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      resource: {
        configuration: Record<string, unknown>;
        configuration_version: number;
        current_release_id: string | null;
        drifted: boolean;
      };
    };
    expect(body.resource).toMatchObject({
      configuration: changed,
      configuration_version: 1,
      current_release_id: null,
      drifted: false,
    });

    const database = db(env.DB);
    expect(
      await database.select().from(deployments).where(eq(deployments.appId, resourceId)).all(),
    ).toEqual([]);
    expect(
      await database.select().from(operations).where(eq(operations.resourceId, resourceId)).all(),
    ).toEqual([]);
  });

  it("fetches resource detail and rejects missing or invalid configuration", async () => {
    const app = createApp(testDeps());
    const server = await createServer(app, `resource-errors-${idCounter}`);
    const { project } = await createProject(app, server.server.id, "jerry");
    const resourceId = await insertResource(server.server.id, project.id);

    const detail = await app.fetch(
      new Request(`http://plane.test/resources/${resourceId}`),
      env,
    );
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { resource: { id: string } }).resource.id).toBe(resourceId);

    const invalid = await app.fetch(
      jsonRequest(`/resources/${resourceId}/configuration`, "PATCH", {
        configuration: { source: { type: "repo", url: "x", ref: "main" } },
      }),
      env,
    );
    expect(invalid.status).toBe(400);

    const clientVersion = await app.fetch(
      jsonRequest(`/resources/${resourceId}/configuration`, "PATCH", {
        configuration: CONFIGURATION,
        configuration_version: 99,
      }),
      env,
    );
    expect(clientVersion.status).toBe(400);

    const accountResource = await insertResource(server.server.id, project.id, "domain", {});
    const unsupportedKind = await app.fetch(
      jsonRequest(`/resources/${accountResource}/configuration`, "PATCH", {
        configuration: {},
      }),
      env,
    );
    expect(unsupportedKind.status).toBe(400);

    const missing = await app.fetch(
      jsonRequest("/resources/res_missing/configuration", "PATCH", {
        configuration: CONFIGURATION,
      }),
      env,
    );
    expect(missing.status).toBe(404);
    expect(
      (await app.fetch(new Request("http://plane.test/resources/res_missing"), env)).status,
    ).toBe(404);
  });
});

describe("deployment API", () => {
  it("copies app ownership and keeps an immutable queued snapshot without approval", async () => {
    const app = createApp(testDeps());
    const server = await createServer(app, `deployment-server-${idCounter}`);
    const { project } = await createProject(app, server.server.id, "jerry");
    const resourceId = await insertResource(server.server.id, project.id);

    const created = await createDeployment(
      app,
      resourceId,
      "abc123",
      noDaemonBindings("the deployment route accessed the daemon namespace"),
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      deployment: Record<string, unknown> & {
        id: string;
        project_id: string;
        app_id: string;
        server_id: string;
        status: string;
        trigger: unknown;
        triggered_by: unknown;
        source_revision: unknown;
        configuration_snapshot: Record<string, unknown>;
      };
    };
    expect(body.deployment).toMatchObject({
      project_id: project.id,
      app_id: resourceId,
      server_id: server.server.id,
      status: "queued",
      trigger: { kind: "manual", commit: "abc123" },
      triggered_by: { kind: "human", id: "operator" },
      source_revision: { ref: "main", commit: "abc123", message: null },
      configuration_snapshot: CONFIGURATION,
      started_at: null,
      finished_at: null,
    });
    expect(body.deployment).not.toHaveProperty("approval");
    expect(body.deployment).not.toHaveProperty("approved_at");

    const changed = {
      ...CONFIGURATION,
      source: { ...CONFIGURATION.source, ref: "next" },
      replicas: 2,
    };
    const saved = await app.fetch(
      jsonRequest(`/resources/${resourceId}/configuration`, "PATCH", {
        configuration: changed,
      }),
      env,
    );
    expect(saved.status).toBe(200);

    const detail = await app.fetch(
      new Request(`http://plane.test/deployments/${body.deployment.id}`),
      env,
    );
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      deployment: { configuration_snapshot: unknown; source_revision: unknown };
    };
    expect(detailBody.deployment.configuration_snapshot).toEqual(CONFIGURATION);
    expect(detailBody.deployment.source_revision).toEqual({
      ref: "main",
      commit: "abc123",
      message: null,
    });

    const appList = await app.fetch(
      new Request(`http://plane.test/resources/${resourceId}/deployments`),
      env,
    );
    expect(appList.status).toBe(200);
    expect(
      ((await appList.json()) as { deployments: { id: string }[] }).deployments.map(({ id }) => id),
    ).toEqual([body.deployment.id]);

    const projectList = await app.fetch(
      new Request(`http://plane.test/projects/${project.id}/deployments`),
      env,
    );
    expect(projectList.status).toBe(200);
    expect(
      ((await projectList.json()) as { deployments: { id: string }[] }).deployments.map(
        ({ id }) => id,
      ),
    ).toEqual([body.deployment.id]);

    const document = (await (await createApp().request("/doc")).json()) as {
      paths: Record<
        string,
        Record<
          string,
          { responses: Record<string, { content?: Record<string, unknown> }> }
        >
      >;
    };
    const foundation = {
      "/projects": ["get", "post"],
      "/projects/{id}": ["get"],
      "/projects/{id}/resources": ["post"],
      "/projects/{id}/deployments": ["get"],
      "/resources/{id}": ["get"],
      "/resources/{id}/configuration": ["patch"],
      "/resources/{id}/deployments": ["get", "post"],
      "/deployments/{id}": ["get"],
      "/operations/{id}": ["get"],
    } as const;

    for (const [path, methods] of Object.entries(foundation)) {
      for (const method of methods) expect(document.paths[path]?.[method]).toBeDefined();
    }

    for (const [path, method, success] of [
      ["/projects", "post", "201"],
      ["/projects/{id}/resources", "post", "201"],
      ["/resources/{id}/configuration", "patch", "200"],
      ["/resources/{id}/deployments", "post", "201"],
    ] as const) {
      const responses = document.paths[path]?.[method]?.responses;
      expect(responses?.[success]?.content?.["application/json"]).toBeDefined();
      expect(responses?.["400"]?.content?.["application/json"]).toBeDefined();
    }

    expect(Object.keys(document.paths).some((path) => path.startsWith("/plans"))).toBe(false);
  });

  it("requires repository commits and keeps image deployments revisionless", async () => {
    const app = createApp(testDeps());
    const server = await createServer(app, `deployment-source-${idCounter}`);
    const { project } = await createProject(app, server.server.id, "jerry");
    const repoApp = await insertResource(server.server.id, project.id);
    const imageApp = await insertResource(
      server.server.id,
      project.id,
      "app",
      IMAGE_CONFIGURATION,
    );

    expect((await createDeployment(app, repoApp, null)).status).toBe(400);
    expect((await createDeployment(app, repoApp, "")).status).toBe(400);
    expect((await createDeployment(app, imageApp, "abc123")).status).toBe(400);

    const approvalInput = await app.fetch(
      jsonRequest(`/resources/${repoApp}/deployments`, "POST", {
        trigger: { kind: "manual", commit: "abc123" },
        approved: true,
      }),
      env,
    );
    expect(approvalInput.status).toBe(400);

    const imageDeployment = await createDeployment(app, imageApp, null);
    expect(imageDeployment.status).toBe(201);
    expect(
      ((await imageDeployment.json()) as { deployment: { source_revision: unknown } }).deployment
        .source_revision,
    ).toBeNull();
  });

  it("rejects resources that do not have valid app ownership", async () => {
    const app = createApp(testDeps());
    const server = await createServer(app, `ownership-server-${idCounter}`);
    const { project } = await createProject(app, server.server.id, "jerry");
    const nonApp = await insertResource(server.server.id, project.id, "database", {});

    expect((await createDeployment(app, nonApp)).status).toBe(409);
    expect((await createDeployment(app, "res_missing")).status).toBe(404);
    expect(
      (
        await app.fetch(
          new Request(`http://plane.test/resources/${nonApp}/deployments`),
          env,
        )
      ).status,
    ).toBe(409);
  });
});

describe("operation detail API", () => {
  it("fetches an attributable operation and reports missing aggregate records", async () => {
    const app = createApp(testDeps());
    const server = await createServer(app, `operation-server-${idCounter}`);
    const { project } = await createProject(app, server.server.id, "jerry");
    const resourceId = await insertResource(server.server.id, project.id);
    const operationId = `opn_fixture_${idCounter++}`;
    await db(env.DB).insert(operations).values({
      id: operationId,
      serverId: server.server.id,
      projectId: project.id,
      resourceId,
      kind: "resource.restart",
      actor: { kind: "agent", id: "claude-code" },
      status: "queued",
      createdAt: NOW,
    });

    const detail = await app.fetch(
      new Request(`http://plane.test/operations/${operationId}`),
      env,
    );
    expect(detail.status).toBe(200);
    expect((await detail.json()) as unknown).toEqual({
      operation: expect.objectContaining({
        id: operationId,
        actor: { kind: "agent", id: "claude-code" },
        status: "queued",
      }),
    });

    expect(
      (await app.fetch(new Request("http://plane.test/deployments/dep_missing"), env)).status,
    ).toBe(404);
    expect(
      (await app.fetch(new Request("http://plane.test/operations/opn_missing"), env)).status,
    ).toBe(404);
    expect(
      (
        await app.fetch(
          new Request("http://plane.test/projects/prj_missing/deployments"),
          env,
        )
      ).status,
    ).toBe(404);

    const ownedRows = await db(env.DB)
      .select()
      .from(operations)
      .where(
        and(
          eq(operations.serverId, server.server.id),
          eq(operations.resourceId, resourceId),
        ),
      )
      .all();
    expect(ownedRows).toHaveLength(1);
  });
});
