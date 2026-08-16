// ADR-0012 — importing a repository is how a deployable Project is created. These tests
// cover the persistence foundation only: the binding, the Plane-owned settings, and the
// boundary validation. Deployment execution is a later slice.

import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { authedApp, authedRequest } from "./access";
import { db, projects, sources } from "../src/db";
import type { Deps } from "../src/deps";
import type { Project } from "../src/schema";

const NOW = 1_700_000_000_000;

// D1 in this pool is shared across `it()` blocks, so ids must be unique across the file.
let idCounter = 0;
let installationCounter = 5_000;

function testDeps(): Deps {
  return {
    clock: { now: () => NOW },
    ids: { id: (prefix) => `${prefix}_imp${idCounter++}` },
  };
}

type App = ReturnType<typeof authedApp>;

function jsonRequest(path: string, body: unknown) {
  return authedRequest(`http://plane.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createServer(app: App, name: string): Promise<string> {
  const response = await app.fetch(
    jsonRequest("/servers", { name, provider: "hetzner", labels: {} }),
    env,
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { server: { id: string } };

  return body.server.id;
}

/** Sources are written by the GitHub callback (tested in sources.test.ts); seed one here. */
async function createSource(login: string): Promise<string> {
  const id = `src_imp${idCounter++}`;
  await db(env.DB)
    .insert(sources)
    .values({
      id,
      provider: "github",
      name: login,
      login,
      installationId: installationCounter++,
      repositorySelection: "all",
      permissions: { contents: "read" },
      events: ["push"],
      createdAt: NOW,
      updatedAt: NOW,
    });

  return id;
}

const SETTINGS = {
  ingress: { service: "web", port: 8080, domains: ["jerry.oflabs.dev"] },
  migration: { service: "app", command: ["php", "artisan", "migrate", "--force"] },
  health: { required_services: ["web", "queue"] },
  variables: {
    APP_ENV: "production",
    // A literal URL is an ordinary value, not a secret reference: only the SecretRef
    // schemes type-design reserves are refused, and refusing every `scheme://` would make
    // the common case — an app URL, a queue address — unwritable.
    APP_URL: "https://jerry.oflabs.dev",
    REDIS_URL: "redis://cache:6379",
    DATABASE_URL: "op://cockpit/jerry/DATABASE_URL",
  },
};

function importBody(overrides: Record<string, unknown> = {}) {
  return {
    server_id: "",
    name: "jerry",
    source_id: "",
    repository_id: "123456",
    repository_full_name: "oflabs44/jerry",
    ref: "main",
    base_directory: "apps/jerry",
    compose_path: "compose.yaml",
    auto_deploy: true,
    settings: SETTINGS,
    ...overrides,
  };
}

/** An import body missing one required field — the binding is all or nothing. */
function importBodyWithout(overrides: Record<string, unknown>, field: string) {
  const body = importBody(overrides) as Record<string, unknown>;
  delete body[field];

  return body;
}

describe("POST /projects/import", () => {
  it("persists the source binding and the plane-owned settings", async () => {
    const app = authedApp(testDeps());
    const serverId = await createServer(app, "import-server");
    const sourceId = await createSource("oflabs44");

    const response = await app.fetch(
      jsonRequest(
        "/projects/import",
        importBody({ server_id: serverId, source_id: sourceId }),
      ),
      env,
    );

    expect(response.status).toBe(201);
    const { project } = (await response.json()) as { project: Project };
    expect(project).toMatchObject({
      server_id: serverId,
      source_id: sourceId,
      name: "jerry",
      repository_id: "123456",
      repository_full_name: "oflabs44/jerry",
      ref: "main",
      base_directory: "apps/jerry",
      compose_path: "compose.yaml",
      auto_deploy: true,
      settings: SETTINGS,
    });

    const row = await db(env.DB)
      .select()
      .from(projects)
      .where(eq(projects.id, project.id))
      .get();
    expect(row?.sourceId).toBe(sourceId);
    expect(row?.autoDeploy).toBe(true);
    // Settings round-trip as JSON, not as a stringified blob.
    expect(row?.settings.ingress?.domains).toEqual(["jerry.oflabs.dev"]);
  });

  it("keeps a project created by POST /projects usable, with no source binding", async () => {
    const app = authedApp(testDeps());
    const serverId = await createServer(app, "plain-server");

    const created = await app.fetch(
      jsonRequest("/projects", { server_id: serverId, name: "plain" }),
      env,
    );
    expect(created.status).toBe(201);

    const detail = (await created.json()) as { project: Project };
    expect(detail.project.source_id).toBeNull();
    expect(detail.project.compose_path).toBeNull();
    expect(detail.project.auto_deploy).toBe(false);
    expect(detail.project.settings).toEqual({
      ingress: null,
      migration: null,
      health: { required_services: [] },
      variables: {},
    });

    // The stack uniqueness index must not collapse unbound projects: SQLite treats each
    // NULL as distinct, so a server can hold many of them.
    const second = await app.fetch(
      jsonRequest("/projects", { server_id: serverId, name: "plain-two" }),
      env,
    );
    expect(second.status).toBe(201);

    const listed = await app.fetch(
      authedRequest(`http://plane.test/projects?server=${serverId}`),
      env,
    );
    expect(listed.status).toBe(200);
    expect((await listed.json()) as { projects: Project[] }).toMatchObject({
      projects: [{ id: detail.project.id, source_id: null }, { name: "plain-two" }],
    });
  });

  it("refuses an unknown server or source", async () => {
    const app = authedApp(testDeps());
    const serverId = await createServer(app, "missing-refs-server");
    const sourceId = await createSource("ghost");

    const noServer = await app.fetch(
      jsonRequest("/projects/import", importBody({ server_id: "srv_nope", source_id: sourceId })),
      env,
    );
    expect(noServer.status).toBe(404);

    const noSource = await app.fetch(
      jsonRequest("/projects/import", importBody({ server_id: serverId, source_id: "src_nope" })),
      env,
    );
    expect(noSource.status).toBe(404);
  });

  it("rejects an incomplete binding, an unsound path, and an unsupported secret scheme", async () => {
    const app = authedApp(testDeps());
    const serverId = await createServer(app, "validation-server");
    const sourceId = await createSource("validation");
    const base = { server_id: serverId, source_id: sourceId };

    const cases: Record<string, unknown> = {
      "missing compose_path": importBodyWithout(base, "compose_path"),
      "missing auto_deploy": importBodyWithout(base, "auto_deploy"),
      "traversing base_directory": importBody({ ...base, base_directory: "../etc" }),
      "absolute compose_path": importBody({ ...base, compose_path: "/etc/compose.yaml" }),
      "non-yaml compose_path": importBody({ ...base, compose_path: "Dockerfile" }),
      "non-numeric repository_id": importBody({ ...base, repository_id: "oflabs44/jerry" }),
      "bare repository name": importBody({ ...base, repository_full_name: "jerry" }),
      // A ref beginning with a dash is not a name git accepts, and it is the shape that
      // reads as an option to every command it is later handed to.
      "ref that reads as a flag": importBody({ ...base, ref: "-main" }),
      "reserved secret scheme": importBody({
        ...base,
        settings: { ...SETTINGS, variables: { TOKEN: "vault://cockpit/token" } },
      }),
      // Schemes are case-insensitive; uppercase must not be the way past the check.
      "reserved secret scheme in caps": importBody({
        ...base,
        settings: { ...SETTINGS, variables: { TOKEN: "AWS://secret/token" } },
      }),
      "ingress port out of range": importBody({
        ...base,
        settings: { ...SETTINGS, ingress: { ...SETTINGS.ingress, port: 70000 } },
      }),
      "a compose service definition smuggled into settings": importBody({
        ...base,
        settings: { ...SETTINGS, image: "nginx:1" },
      }),
    };

    for (const [name, body] of Object.entries(cases)) {
      const response = await app.fetch(jsonRequest("/projects/import", body), env);
      expect(response.status, name).toBe(400);
    }
  });

  // Only a *leading* dash is refused. Release branches and tags carry dashes everywhere
  // else, and refusing those would make the check the operator's problem.
  it("accepts an ordinary ref that contains dashes", async () => {
    const app = authedApp(testDeps());
    const serverId = await createServer(app, "ref-server");
    const sourceId = await createSource("refs");

    for (const ref of ["release-1.2", "feature/add-queue-worker", "v2.0.0-rc.1"]) {
      const response = await app.fetch(
        jsonRequest(
          "/projects/import",
          importBody({ server_id: serverId, source_id: sourceId, name: ref.replace(/\W/g, "-"), ref }),
        ),
        env,
      );
      expect(response.status, ref).toBe(201);
      expect(((await response.json()) as { project: Project }).project.ref).toBe(ref);
    }
  });

  it("imports the same repository twice under different compose paths, but not twice", async () => {
    const app = authedApp(testDeps());
    const serverId = await createServer(app, "monorepo-server");
    const sourceId = await createSource("monorepo");
    const base = importBody({ server_id: serverId, source_id: sourceId, name: "api" });

    const first = await app.fetch(jsonRequest("/projects/import", base), env);
    expect(first.status).toBe(201);

    const second = await app.fetch(
      jsonRequest("/projects/import", {
        ...base,
        name: "worker",
        base_directory: "apps/worker",
      }),
      env,
    );
    expect(second.status).toBe(201);

    const duplicateStack = await app.fetch(
      jsonRequest("/projects/import", { ...base, name: "api-again" }),
      env,
    );
    expect(duplicateStack.status).toBe(409);

    const duplicateName = await app.fetch(
      jsonRequest("/projects/import", { ...base, base_directory: "apps/third" }),
      env,
    );
    expect(duplicateName.status).toBe(409);
  });

  // The ref is part of what makes a stack: the same directory and Compose file on `main`
  // and on `staging` are two deployable Projects, and the uniqueness index must not read
  // the second as a re-import of the first.
  it("imports the same stack on two refs, and still refuses the same stack on one", async () => {
    const app = authedApp(testDeps());
    const serverId = await createServer(app, "branch-server");
    const sourceId = await createSource("branches");
    const base = importBody({ server_id: serverId, source_id: sourceId, name: "shop" });

    const production = await app.fetch(jsonRequest("/projects/import", base), env);
    expect(production.status).toBe(201);

    const staging = await app.fetch(
      jsonRequest("/projects/import", { ...base, name: "shop-staging", ref: "staging" }),
      env,
    );
    expect(staging.status).toBe(201);

    const sameRefAgain = await app.fetch(
      jsonRequest("/projects/import", { ...base, name: "shop-again", ref: "staging" }),
      env,
    );
    expect(sameRefAgain.status).toBe(409);
  });
});
