// Route-level tests for the plans slice. Same module-level-id-counter and app.fetch(request,
// env) approach as test/enrolment.test.ts — see that file's header comments for why.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "@hono/zod-openapi";
import { createApp } from "../src/app";
import type { Deps } from "../src/deps";
import { KINDS } from "../src/kinds";
import { makePlanner } from "../src/plan/planner";

let idCounter = 0;
const NOW = 1_700_000_000_000;

function testDeps(nowMs = NOW): Deps {
  return {
    clock: { now: () => nowMs },
    ids: { id: (prefix) => `${prefix}_p${idCounter++}` },
  };
}

function tick(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.addEventListener("message", (event) => resolve(JSON.parse(event.data as string)), {
      once: true,
    });
  });
}

type App = ReturnType<typeof createApp>;

async function createServer(app: App, name: string) {
  const res = await app.fetch(
    new Request("http://plane.test/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, provider: "hetzner", labels: {} }),
    }),
    env,
  );
  return (await res.json()) as { token: string; server: { id: string } };
}

async function enrol(app: App, name: string) {
  const { token, server } = await createServer(app, name);
  const upgrade = await app.fetch(
    new Request("http://plane.test/daemon", {
      headers: { upgrade: "websocket", authorization: `Bearer ${token}` },
    }),
    env,
  );
  const ws = upgrade.webSocket;
  if (!ws) throw new Error("expected a websocket");
  ws.accept();
  const welcome = waitForMessage(ws);
  ws.send(
    JSON.stringify({
      type: "hello",
      agent_version: "1.2.3",
      arch: "arm64",
      hostname: "scratch-box",
      auth: { kind: "enrolment", secret: token },
    }),
  );
  await welcome;

  return { ws, server };
}

/** Send one full observed snapshot, as the daemon would on connect. */
async function reportState(
  ws: WebSocket,
  rev: number,
  resources: { kind: string; name: string; detail: Record<string, unknown> }[],
  probes: Record<string, string> = { docker: "ok", cron: "ok" },
) {
  ws.send(
    JSON.stringify({
      type: "state",
      rev,
      resources: resources.map((r) => ({
        kind: r.kind,
        name: r.name,
        observed: { exists: true, health: "healthy", detail: r.detail, observed_at: 1_700_000_001 },
      })),
      probes,
    }),
  );
  await tick();
}

const SPEC = {
  image: "ghcr.io/oflabs44/jerry:1.0.0",
  ports: [{ container: 8080, protocol: "tcp" }],
  env: { LOG_LEVEL: "info", DATABASE_URL: "op://cockpit/jerry/DATABASE_URL" },
  labels: { "traefik.enable": "true" },
  restart: "unless-stopped",
  limits: { cpu: "1", memory: "512m" },
};

const OBSERVED_MATCHING = {
  container_id: "abc",
  image: SPEC.image,
  restart_policy: SPEC.restart,
  labels: SPEC.labels,
};

// A bodyless POST defaults to `text/plain` for Hono's `csrf()`, which then demands a
// same-origin `Origin` (or `Sec-Fetch-Site`) header — so an approve/reject sent without one is
// a 403, exactly as a cross-origin page's would be. Real clients send it; the tests must too.
const POST: RequestInit = { method: "post", headers: { origin: "http://plane.test" } };

function putResource(
  app: App,
  serverId: string,
  name: string,
  spec: unknown,
  kind = "app",
  extra: Record<string, unknown> = {},
) {
  return app.fetch(
    new Request(`http://plane.test/servers/${serverId}/resources/${kind}/${name}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spec, ...extra }),
    }),
    env,
  );
}

type PlanBody = {
  plan: {
    id: string | null;
    status: string;
    changes: { op: string; impact: string; inverse: unknown; before: unknown; after: unknown }[];
    basis: { observed_rev: number; observed_at: number | null };
    undiffable_keys: string[];
    decided_at: number | null;
    max_impact: string;
    created_by: { kind: string; id: string };
    decided_by: { kind: string; id: string } | null;
    approved_at: number | null;
  };
};

describe("PUT /servers/:id/resources/:kind/:name", () => {
  it("refuses to plan against a server with no observed snapshot (#7)", async () => {
    const app = createApp(testDeps());
    const { server } = await createServer(app, "pln-blind");

    const res = await putResource(app, server.id, "jerry", SPEC);

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/cannot plan blind/);
  });

  it("plans a create against an empty box and records the basis it diffed", async () => {
    const app = createApp(testDeps());
    const { ws, server } = await enrol(app, "pln-create");
    await reportState(ws, 3, []);

    const res = await putResource(app, server.id, "jerry", SPEC);
    expect(res.status).toBe(201);

    const { plan } = (await res.json()) as PlanBody;
    expect(plan.id).not.toBeNull();
    expect(plan.status).toBe("pending");
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]?.op).toBe("resource.create");
    expect(plan.changes[0]?.inverse).not.toBeNull();
    expect(plan.max_impact).toBe("restart");
    // Invariant: the basis names the observed revision the diff was computed against, not the
    // plane's last-known desired state.
    expect(plan.basis.observed_rev).toBe(3);
    expect(plan.created_by).toEqual({ kind: "human", id: "operator" });
    expect(plan.decided_by).toBeNull();
  });

  it("returns a transient no-op plan, and persists nothing, when the diff is empty", async () => {
    const app = createApp(testDeps());
    const { ws, server } = await enrol(app, "pln-noop");
    await reportState(ws, 1, [{ kind: "app", name: "jerry", detail: OBSERVED_MATCHING }]);

    const res = await putResource(app, server.id, "jerry", SPEC);

    expect(res.status).toBe(200);
    const { plan } = (await res.json()) as PlanBody;
    expect(plan.id).toBeNull();
    expect(plan.changes).toEqual([]);
    expect(plan.max_impact).toBe("none");

    const list = await app.fetch(
      new Request(`http://plane.test/plans?server=${server.id}`),
      env,
    );
    expect(((await list.json()) as { plans: unknown[] }).plans).toHaveLength(0);
  });

  it("plans against a changed observed state, not against the spec it already stored", async () => {
    const app = createApp(testDeps());
    const { ws, server } = await enrol(app, "pln-drift");
    await reportState(ws, 1, [{ kind: "app", name: "jerry", detail: OBSERVED_MATCHING }]);

    // First PUT: box already matches, so nothing to do.
    const first = (await (await putResource(app, server.id, "jerry", SPEC)).json()) as PlanBody;
    expect(first.plan.changes).toEqual([]);

    // Someone changes the image out of band. Same desired spec, new observed state.
    await reportState(ws, 2, [
      { kind: "app", name: "jerry", detail: { ...OBSERVED_MATCHING, image: "ghcr.io/x:hand-rolled" } },
    ]);

    const second = (await (await putResource(app, server.id, "jerry", SPEC)).json()) as PlanBody;
    expect(second.plan.changes).toHaveLength(1);
    expect(second.plan.changes[0]?.op).toBe("resource.update");
    expect(second.plan.changes[0]?.impact).toBe("replace");
    expect(second.plan.basis.observed_rev).toBe(2);
  });

  it("stores the spec verbatim, secret refs included, and never resolves one", async () => {
    const app = createApp(testDeps());
    const { ws, server } = await enrol(app, "pln-secret");
    await reportState(ws, 1, []);

    await putResource(app, server.id, "jerry", SPEC);

    const res = await app.fetch(
      new Request(`http://plane.test/servers/${server.id}/resources`),
      env,
    );
    const body = (await res.json()) as { resources: { spec: { env: Record<string, string> } }[] };

    expect(body.resources[0]?.spec.env.DATABASE_URL).toBe("op://cockpit/jerry/DATABASE_URL");
    // The whole response, plan included, still contains the ref and no dereferenced value.
    const plans = await (
      await app.fetch(new Request(`http://plane.test/plans?server=${server.id}`), env)
    ).text();
    expect(plans).toContain("op://cockpit/jerry/DATABASE_URL");
  });

  it("rejects an unknown kind and a spec that fails its kind's schema", async () => {
    const app = createApp(testDeps());
    const { ws, server } = await enrol(app, "pln-invalid");
    await reportState(ws, 1, []);

    const unknownKind = await app.fetch(
      new Request(`http://plane.test/servers/${server.id}/resources/unicorn/x`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ spec: {} }),
      }),
      env,
    );
    expect(unknownKind.status).toBe(400);

    const badSpec = await putResource(app, server.id, "jerry", { image: "x" }); // no limits
    expect(badSpec.status).toBe(400);
  });

  // A soft-failed probe must not read as an empty box: with docker `unavailable`, every app
  // looks absent, and planning a create over a running container is the mistake `probes` exists
  // to prevent (type-design §3.1).
  it("refuses to plan when the probe covering this kind is not ok", async () => {
    const app = createApp(testDeps());
    const { ws, server } = await enrol(app, "pln-probe");
    await reportState(ws, 1, [], { docker: "unavailable", cron: "ok" });

    const res = await putResource(app, server.id, "jerry", SPEC);

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/docker probe is not reporting ok/);
  });

  // Env, ports and limits are not observed today, so a change to one of them produces no plan.
  // The response has to say that out loud — silence reads as "already correct".
  it("names spec keys it cannot diff instead of reporting a bare no-op", async () => {
    const app = createApp(testDeps());
    const { ws, server } = await enrol(app, "pln-undiffable");
    await reportState(ws, 1, [{ kind: "app", name: "jerry", detail: OBSERVED_MATCHING }]);

    await putResource(app, server.id, "jerry", SPEC);
    const res = await putResource(app, server.id, "jerry", {
      ...SPEC,
      env: { ...SPEC.env, LOG_LEVEL: "debug" },
      limits: { cpu: "2", memory: "1g" },
    });

    expect(res.status).toBe(200);
    const { plan } = (await res.json()) as PlanBody;
    expect(plan.changes).toEqual([]);
    expect(plan.undiffable_keys.sort()).toEqual(["env", "limits"]);
  });

  it("does not clear project_id when a later PUT omits it", async () => {
    const app = createApp(testDeps());
    const { ws, server } = await enrol(app, "pln-project");
    await reportState(ws, 1, []);

    await putResource(app, server.id, "jerry", SPEC, "app", { project_id: "prj_1" });
    await putResource(app, server.id, "jerry", { ...SPEC, image: "ghcr.io/x:2" });

    const res = await app.fetch(
      new Request(`http://plane.test/servers/${server.id}/resources`),
      env,
    );
    const body = (await res.json()) as { resources: { project_id: string | null }[] };
    expect(body.resources[0]?.project_id).toBe("prj_1");
  });

  it("404s for a server that does not exist", async () => {
    const app = createApp(testDeps());
    expect((await putResource(app, "srv_nope", "jerry", SPEC)).status).toBe(404);
  });

  it("upserts rather than duplicating on a second PUT for the same (server, kind, name)", async () => {
    const app = createApp(testDeps());
    const { ws, server } = await enrol(app, "pln-upsert");
    await reportState(ws, 1, []);

    await putResource(app, server.id, "jerry", SPEC);
    await putResource(app, server.id, "jerry", { ...SPEC, image: "ghcr.io/oflabs44/jerry:2" });

    const res = await app.fetch(
      new Request(`http://plane.test/servers/${server.id}/resources`),
      env,
    );
    const body = (await res.json()) as { resources: { spec: { image: string } }[] };
    expect(body.resources).toHaveLength(1);
    expect(body.resources[0]?.spec.image).toBe("ghcr.io/oflabs44/jerry:2");
  });
});

describe("plan lifecycle", () => {
  async function pendingPlan(app: App, name: string) {
    const { ws, server } = await enrol(app, name);
    await reportState(ws, 1, []);
    const { plan } = (await (await putResource(app, server.id, "jerry", SPEC)).json()) as PlanBody;

    return { server, planId: plan.id as string };
  }

  it("lists and fetches a plan", async () => {
    const app = createApp(testDeps());
    const { server, planId } = await pendingPlan(app, "pln-read");

    const list = (await (
      await app.fetch(new Request(`http://plane.test/plans?status=pending&server=${server.id}`), env)
    ).json()) as { plans: { id: string }[] };
    expect(list.plans.map((p) => p.id)).toContain(planId);

    const detail = await app.fetch(new Request(`http://plane.test/plans/${planId}`), env);
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as PlanBody).plan.id).toBe(planId);

    expect((await app.fetch(new Request("http://plane.test/plans/pln_nope"), env)).status).toBe(404);
  });

  it("approves a pending plan without executing anything", async () => {
    const app = createApp(testDeps());
    const { planId } = await pendingPlan(app, "pln-approve");

    const res = await app.fetch(
      new Request(`http://plane.test/plans/${planId}/approve`, POST),
      env,
    );
    expect(res.status).toBe(200);

    const { plan } = (await res.json()) as PlanBody;
    expect(plan.status).toBe("approved");
    expect(plan.approved_at).toBe(NOW);
    expect(plan.decided_by).toEqual({ kind: "human", id: "operator" });
    // Approval is not application: the changes are untouched and still pending.
    expect(plan.changes.every((change) => "inverse" in change)).toBe(true);

    // Approving twice is a conflict, not a silent re-stamp.
    const again = await app.fetch(
      new Request(`http://plane.test/plans/${planId}/approve`, POST),
      env,
    );
    expect(again.status).toBe(409);

    // The web rail's Plans badge counts `?status=pending` — the filter must actually
    // exclude a decided plan, not just include fresh ones.
    const pending = (await (
      await app.fetch(new Request("http://plane.test/plans?status=pending"), env)
    ).json()) as { plans: { id: string | null }[] };
    expect(pending.plans.map((p) => p.id)).not.toContain(planId);
  });

  it("rejects a pending plan, terminally", async () => {
    const app = createApp(testDeps());
    const { planId } = await pendingPlan(app, "pln-reject");

    const res = await app.fetch(
      new Request(`http://plane.test/plans/${planId}/reject`, POST),
      env,
    );
    expect(res.status).toBe(200);

    const { plan } = (await res.json()) as PlanBody;
    expect(plan.status).toBe("rejected");
    expect(plan.approved_at).toBeNull();
    // Fully attributed: who decided, and when — a rejection is not a half-recorded decision.
    expect(plan.decided_at).toBe(NOW);
    expect(plan.decided_by).toEqual({ kind: "human", id: "operator" });

    const approveAfter = await app.fetch(
      new Request(`http://plane.test/plans/${planId}/approve`, POST),
      env,
    );
    expect(approveAfter.status).toBe(409);
  });

  it("404s approving or rejecting a plan that does not exist", async () => {
    const app = createApp(testDeps());
    for (const action of ["approve", "reject"]) {
      const res = await app.fetch(
        new Request(`http://plane.test/plans/pln_nope/${action}`, POST),
        env,
      );
      expect(res.status).toBe(404);
    }
  });
});

// A corrupt plan row is an audit record that lost its contents. Rendering it with defaults
// would produce a plan that looks empty, harmless, and proposed by the operator — none of
// which is known to be true.
describe("corrupt plan records", () => {
  async function corruptPlanRow(app: App, name: string, column: "changes" | "actor" | "basis") {
    const { ws, server } = await enrol(app, name);
    await reportState(ws, 1, []);
    const { plan } = (await (await putResource(app, server.id, "jerry", SPEC)).json()) as PlanBody;
    await env.DB.prepare(`UPDATE plans SET ${column} = ? WHERE id = ?`)
      .bind("{not json", plan.id)
      .run();

    return { server, planId: plan.id as string };
  }

  it("500s rather than rendering a corrupt plan as an empty one", async () => {
    const app = createApp(testDeps());
    const { planId } = await corruptPlanRow(app, "pln-corrupt-detail", "changes");

    const res = await app.fetch(new Request(`http://plane.test/plans/${planId}`), env);

    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/corrupt: changes/);
  });

  it("refuses to approve a plan whose changes cannot be read", async () => {
    const app = createApp(testDeps());
    const { planId } = await corruptPlanRow(app, "pln-corrupt-approve", "changes");

    const res = await app.fetch(
      new Request(`http://plane.test/plans/${planId}/approve`, POST),
      env,
    );
    expect(res.status).toBe(500);

    // And it stayed pending: a plan nobody could read is not a plan anybody approved.
    const row = await env.DB.prepare("SELECT status FROM plans WHERE id = ?").bind(planId).first();
    expect(row?.status).toBe("pending");
  });

  it("500s on a corrupt actor or basis too, not just changes", async () => {
    const app = createApp(testDeps());
    for (const column of ["actor", "basis"] as const) {
      const { planId } = await corruptPlanRow(app, `pln-corrupt-${column}`, column);
      const res = await app.fetch(new Request(`http://plane.test/plans/${planId}`), env);

      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: string }).error).toContain(column);
    }
  });

  it("marks a corrupt row in the list instead of synthesizing one", async () => {
    const app = createApp(testDeps());
    const { server, planId } = await corruptPlanRow(app, "pln-corrupt-list", "actor");

    const res = await app.fetch(new Request(`http://plane.test/plans?server=${server.id}`), env);
    expect(res.status).toBe(200);

    const { plans: listed } = (await res.json()) as {
      plans: { id: string; corrupt?: boolean; summary: string; created_by?: unknown }[];
    };
    const row = listed.find((p) => p.id === planId);

    expect(row?.corrupt).toBe(true);
    expect(row?.summary).toMatch(/unreadable plan record: corrupt actor/);
    // No invented audit data: no actor, no changes, no impact.
    expect(row?.created_by).toBeUndefined();
    expect(row).not.toHaveProperty("max_impact");
  });
});

// Invariant 11: adding a kind touches the registry and a daemon handler, nothing else. This
// registers one at runtime and drives the REAL route — same PUT, same table, same plan
// storage, same reads — because that is the claim being made.
describe("kind registry extensibility, end to end", () => {
  it("plans, stores, and serves a kind the route has never heard of before", async () => {
    const QueueSpec = z.object({ concurrency: z.number().int().positive() });
    KINDS.queue = {
      specSchema: QueueSpec,
      planner: makePlanner({
        specSchema: QueueSpec,
        project: (detail) => ("concurrency" in detail ? { concurrency: detail.concurrency } : {}),
        updateImpact: () => "reload",
      }),
      probe: "docker",
    };

    try {
      const app = createApp(testDeps());
      const { ws, server } = await enrol(app, "pln-queue");
      await reportState(ws, 1, []);

      const created = await putResource(app, server.id, "emails", { concurrency: 4 }, "queue");
      expect(created.status).toBe(201);

      const { plan } = (await created.json()) as PlanBody;
      expect(plan.changes[0]?.op).toBe("resource.create");
      expect(plan.changes[0]?.after).toEqual({
        kind: "queue",
        name: "emails",
        spec: { concurrency: 4 },
      });

      // Readable back through the generic paths, with no kind-specific code anywhere.
      const detail = await app.fetch(new Request(`http://plane.test/plans/${plan.id}`), env);
      expect(detail.status).toBe(200);
      expect(((await detail.json()) as PlanBody).plan.changes).toHaveLength(1);

      const listed = await app.fetch(
        new Request(`http://plane.test/servers/${server.id}/resources`),
        env,
      );
      const body = (await listed.json()) as { resources: { kind: string; name: string }[] };
      expect(body.resources).toEqual([expect.objectContaining({ kind: "queue", name: "emails" })]);

      // And the update path, against a box that now reports it.
      await reportState(ws, 2, [{ kind: "queue", name: "emails", detail: { concurrency: 2 } }]);
      const updated = await putResource(app, server.id, "emails", { concurrency: 4 }, "queue");
      expect(updated.status).toBe(201);
      expect(((await updated.json()) as PlanBody).plan.changes[0]?.impact).toBe("reload");
    } finally {
      delete KINDS.queue;
    }
  });

  it("400s a kind that is not registered", async () => {
    const app = createApp(testDeps());
    const { ws, server } = await enrol(app, "pln-unknown-kind");
    await reportState(ws, 1, []);

    const res = await putResource(app, server.id, "x", {}, "unicorn");
    expect(res.status).toBe(400);
  });
});
