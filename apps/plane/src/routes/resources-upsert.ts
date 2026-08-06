// PUT /servers/{id}/resources/{kind}/{name} — record desired state and plan against observed.
//
// The spec written here is INTENT, not fact: nothing on the box changes until the resulting
// plan is approved and applied (ADR-0003). There is deliberately no route that mutates a
// resource without producing a plan.

import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, sql } from "drizzle-orm";
import type { AppRouteHandler } from "../app";
import { db, plans, resources, servers } from "../db";
import { kindEntry } from "../kinds";
import { OPERATOR, parsePlanRow } from "../plan/row";
import { deepEqual } from "../plan/planner";
import { maxImpact, summarise } from "../plan/types";
import type { Basis, Change } from "../plan/types";
import { ErrorResponse, PlanResponse, UpsertResourceBody } from "../schema";
import { safeJsonParse } from "../json";

export const upsertResourceRoute = createRoute({
  method: "put",
  path: "/servers/{id}/resources/{kind}/{name}",
  request: {
    params: z.object({ id: z.string(), kind: z.string(), name: z.string() }),
    body: { content: { "application/json": { schema: UpsertResourceBody } } },
  },
  responses: {
    200: {
      description: "Spec recorded; the diff was empty, so a transient no-op plan is returned",
      content: { "application/json": { schema: PlanResponse } },
    },
    201: {
      description: "Spec recorded and a plan persisted, pending approval",
      content: { "application/json": { schema: PlanResponse } },
    },
    400: {
      description: "Unknown kind, or the spec failed its kind's schema",
      content: { "application/json": { schema: ErrorResponse } },
    },
    404: { description: "No such server" },
    409: {
      description: "This kind was not observed on this server — cockpit cannot plan blind (#7)",
      content: { "application/json": { schema: ErrorResponse } },
    },
  },
});

export const upsertResourceHandler: AppRouteHandler<typeof upsertResourceRoute> = async (c) => {
  const { id: serverId, kind, name } = c.req.valid("param");
  const body = c.req.valid("json");
  const deps = c.var.deps;
  const now = deps.clock.now();
  const database = db(c.env.DB);

  const entry = kindEntry(kind);
  if (!entry) return c.json({ error: `unknown kind: ${kind}` }, 400);

  const server = await database.select().from(servers).where(eq(servers.id, serverId)).get();
  if (!server) return c.body(null, 404);

  const parsed = entry.specSchema.safeParse(body.spec);
  if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
  // Whatever the schema produced, verbatim. Secret refs in `env` pass through untouched: the
  // plane stores the ref and never the value (#15, ADR-0008).
  const desired = parsed.data as Record<string, unknown>;

  // Plans are computed against observed state, never last-known desired state (#7). With no
  // snapshot there is nothing honest to diff against, and guessing "it must be absent" would
  // plan a create over a box that may already be running the thing.
  const stub = c.env.SERVER_DO.get(c.env.SERVER_DO.idFromName(`server:${serverId}`));
  const snapshot = await stub.getSnapshot();
  if (!snapshot) {
    return c.json({ error: "no observed state for this server yet; cannot plan blind" }, 409);
  }
  // The same refusal, one probe finer. A soft-failed probe reports `unavailable` precisely so
  // its silence cannot be read as "nothing is there" (type-design §3.1): with docker down,
  // every app looks absent, and planning a create over a running container is the exact
  // mistake the probes field exists to prevent.
  if (snapshot.probes?.[entry.probe] !== "ok") {
    return c.json(
      {
        error: `the ${entry.probe} probe is not reporting ok on this server; cannot plan ${kind} blind`,
      },
      409,
    );
  }

  const existing = await database
    .select()
    .from(resources)
    .where(and(eq(resources.serverId, serverId), eq(resources.kind, kind), eq(resources.name, name)))
    .get();

  const resourceId = existing?.id ?? deps.ids.id("res");
  const storedSpec = existing
    ? safeJsonParse<Record<string, unknown> | null>(
        existing.spec,
        null,
        `resources.spec (${existing.id})`,
      )
    : null;

  const seen = snapshot.resources.find((r) => r.kind === kind && r.name === name);
  const changes = entry.planner({
    resourceId,
    kind,
    name,
    desired,
    stored: storedSpec,
    observed: seen ? { exists: seen.observed.exists, detail: seen.observed.detail } : null,
  });

  // basis pins the snapshot this diff was computed against. Apply MUST revalidate it against
  // the resource's current `observed_rev` and refuse a stale plan rather than force-applying
  // (invariant 4, ADR-0003) — that check belongs to the apply slice and does not exist yet.
  const basis: Basis = {
    observed_rev: snapshot.rev,
    observed_at: seen?.observed.observed_at ?? null,
  };

  const undiffableKeys = undiffable(desired, storedSpec, changes);

  const spec = JSON.stringify(desired);
  // ON CONFLICT on the identity index rather than "did the SELECT above find one": two first
  // PUTs for the same (server, kind, name) otherwise both take the insert branch and one 500s.
  // `project_id` is only overwritten when the request actually carried the field.
  const upsertResource = database.run(sql`
    INSERT INTO resources (id, server_id, project_id, kind, name, spec, created_at, updated_at)
    VALUES (${resourceId}, ${serverId}, ${body.project_id ?? null}, ${kind}, ${name}, ${spec}, ${now}, ${now})
    ON CONFLICT (COALESCE(server_id, ''), kind, name) DO UPDATE SET
      spec = excluded.spec,
      updated_at = excluded.updated_at
      ${body.project_id === undefined ? sql`` : sql`, project_id = excluded.project_id`}
  `);

  // An empty diff is a no-op plan: returned so the caller sees "nothing to do", never
  // persisted, so the plan list stays a list of real proposed change.
  if (changes.length === 0) {
    await upsertResource;

    return c.json(
      {
        plan: {
          id: null,
          server_id: serverId,
          resource_id: resourceId,
          status: "pending" as const,
          changes,
          basis,
          summary: summarise(changes, kind, name),
          max_impact: maxImpact(changes),
          created_by: OPERATOR,
          decided_by: null,
          undiffable_keys: undiffableKeys,
          created_at: now,
          decided_at: null,
          approved_at: null,
        },
      },
      200,
    );
  }

  const planId = deps.ids.id("pln");
  // One batch, so a stored spec without its plan is not a reachable state: D1 runs a batch in
  // an implicit transaction, and the plan's FK on resource_id makes a lost insert race fail the
  // whole batch rather than commit half of it.
  await database.batch([
    upsertResource,
    database.insert(plans).values({
      id: planId,
      serverId,
      resourceId,
      status: "pending",
      changes: JSON.stringify(changes),
      basis: JSON.stringify(basis),
      actor: JSON.stringify({ created_by: OPERATOR, decided_by: null }),
      createdAt: now,
      decidedAt: null,
      approvedAt: null,
    }),
  ]);

  const row = await database.select().from(plans).where(eq(plans.id, planId)).get();
  // Re-read rather than reconstruct: one mapping (`parsePlanRow`) produces every plan the API
  // ever returns, so a stored plan and a just-created one cannot drift in shape.
  if (!row) throw new Error(`plan ${planId} vanished immediately after insert`);
  const result = parsePlanRow(row);
  if (!result.ok) throw new Error(`plan ${planId} unreadable immediately after insert`);

  return c.json({ plan: { ...result.plan, undiffable_keys: undiffableKeys } }, 201);
};

/** Keys the caller changed that the plan cannot speak for: different from the stored spec, but
 *  not part of any change, because this kind cannot observe them. Silence about these reads as
 *  "already correct", which is the opposite of the truth. */
function undiffable(
  desired: Record<string, unknown>,
  stored: Record<string, unknown> | null,
  changes: Change[],
): string[] {
  if (!stored) return [];

  const change = changes[0];
  const diffed = new Set(
    change?.before && change.after
      ? Object.keys(change.after.spec).filter(
          (key) => !deepEqual(change.after?.spec[key], change.before?.spec[key]),
        )
      : [],
  );
  // A create or delete speaks for the whole spec; nothing is left unsaid.
  if (change && (!change.before || !change.after)) return [];

  return Object.keys(desired).filter(
    (key) => !deepEqual(desired[key], stored[key]) && !diffed.has(key),
  );
}
