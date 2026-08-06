// Plan row -> API shape. `summary` and `max_impact` are derived here on every read rather than
// stored, so a client can never supply them (invariant 8) and they cannot go stale against
// `changes`.
//
// A corrupt row is NOT parsed leniently. Everywhere else in this codebase a bad JSON column
// falls back to an empty value so one row cannot take down a list — but a plan's columns are
// the audit record itself, and a defaulted one reads as "no changes, impact none, proposed by
// operator": a fabricated, innocuous-looking plan. `parsePlanRow` reports the corruption
// instead, and each caller decides (500 on a single read, a marked row in a list).

import type { plans } from "../db";
import { ActorSchema, ChangeSchema, PlanStatus } from "../schema";
import { maxImpact, summarise } from "./types";
import type { Actor, Basis, Change } from "./types";
import { z } from "@hono/zod-openapi";

/** No auth yet (see the SECURITY note in src/app.ts): every plan is attributed to the single
 *  operator. TODO: take the actor from the authenticated principal — a human from Cloudflare
 *  Access, an agent from its MCP credential — once one exists. */
export const OPERATOR: Actor = { kind: "human", id: "operator" };

export interface PlanActors {
  created_by: Actor;
  decided_by: Actor | null;
}

const ActorsSchema = z.object({
  created_by: ActorSchema,
  decided_by: ActorSchema.nullable(),
});
const BasisSchema = z.object({
  observed_rev: z.number(),
  observed_at: z.number().nullable(),
});

type PlanRow = typeof plans.$inferSelect;

export type ApiPlan = ReturnType<typeof buildPlan>;

export type PlanParse =
  | { ok: true; plan: ApiPlan }
  /** `corruption` names the columns that failed, for the log line and the list marker. */
  | { ok: false; corruption: string };

/** A plan whose stored form could not be trusted. Carries only the columns that are plain
 *  scalars — no changes, no basis, no actor — so nothing about it is invented. */
export interface CorruptPlan {
  id: string;
  server_id: string;
  resource_id: string;
  corrupt: true;
  summary: string;
  created_at: number;
}

export function parsePlanRow(row: PlanRow): PlanParse {
  const bad: string[] = [];

  const status = PlanStatus.safeParse(row.status);
  if (!status.success) bad.push(`status (${row.status})`);

  const changes = z.array(ChangeSchema).safeParse(parseJson(row.changes));
  if (!changes.success) bad.push("changes");

  const actors = ActorsSchema.safeParse(parseJson(row.actor));
  if (!actors.success) bad.push("actor");

  const basis = BasisSchema.safeParse(parseJson(row.basis));
  if (!basis.success) bad.push("basis");

  if (!status.success || !changes.success || !actors.success || !basis.success) {
    return { ok: false, corruption: bad.join(", ") };
  }

  return {
    ok: true,
    plan: buildPlan(row, status.data, changes.data as Change[], actors.data, basis.data),
  };
}

export function corruptPlan(row: PlanRow, corruption: string): CorruptPlan {
  return {
    id: row.id,
    server_id: row.serverId,
    resource_id: row.resourceId,
    corrupt: true,
    summary: `unreadable plan record: corrupt ${corruption}`,
    created_at: row.createdAt,
  };
}

/** Unparseable text becomes `undefined`, which every schema above rejects — so "not JSON" and
 *  "JSON of the wrong shape" arrive at the same reported corruption. */
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function buildPlan(
  row: PlanRow,
  status: z.infer<typeof PlanStatus>,
  changes: Change[],
  actors: PlanActors,
  basis: Basis,
) {
  const first = changes[0];
  const kind = first?.after?.kind ?? first?.before?.kind ?? "resource";
  const name = first?.after?.name ?? first?.before?.name ?? row.resourceId;

  return {
    id: row.id,
    server_id: row.serverId,
    resource_id: row.resourceId,
    status,
    changes,
    basis,
    summary: summarise(changes, kind, name),
    max_impact: maxImpact(changes),
    created_by: actors.created_by,
    decided_by: actors.decided_by,
    // Reported on the plan, not just in the diff: a spec field the daemon cannot observe
    // cannot produce a change, and silence about that reads as "nothing to do".
    undiffable_keys: [] as string[],
    created_at: row.createdAt,
    decided_at: row.decidedAt,
    approved_at: row.approvedAt,
  };
}
