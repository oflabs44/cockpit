// The planner is a diff function, not an engine: desired spec + the latest observed snapshot
// for one (server, kind, name) in, `Change[]` out. Pure — no clock, no ids, no I/O, no
// database (CONTEXT conventions: determinism). Persisting the result is the route's job.
//
// Plans diff OBSERVED state, never last-known desired state (#7). The consequence, and the
// honest limit of this slice: a spec field the daemon does not report cannot produce a
// change. `project()` below is each kind's declaration of which spec fields it can actually
// see on the box; everything else is undiffable until observation widens.
//
// The stored spec still has one job, and only one: reconstructing a COMPLETE `before` so the
// inverse is a real spec rather than a fragment (#8). Observed values win over stored ones on
// every field the daemon reports, so the diff itself is still against the box.

import type { z } from "@hono/zod-openapi";
import type { Change, Impact, InverseChange, PlanOp, Target } from "./types";

/** One resource's observed state, as reported by the daemon (type-design §2.4). `null` means
 *  the snapshot said nothing about it — for a kind whose probe was `ok`, that is absence. */
export interface ObservedResource {
  exists: boolean;
  detail: Record<string, unknown>;
}

export interface PlanRequest {
  resourceId: string;
  kind: string;
  name: string;
  /** The desired spec, already validated by the kind's schema. `null` means "delete". */
  desired: Record<string, unknown> | null;
  /** The spec cockpit last recorded for this resource, or null if it is unmanaged — the box
   *  is running something nobody here described yet. Never used to compute the diff (#7). */
  stored: Record<string, unknown> | null;
  observed: ObservedResource | null;
}

export type Planner = (req: PlanRequest) => Change[];

export interface KindPlannerRules {
  /** The kind's spec schema. Used for one thing: deciding whether a reconstructed `before` is
   *  a whole, valid spec. If it is not, the change is irreversible rather than carrying an
   *  inverse that would fail on apply. */
  specSchema: z.ZodType;
  /** Observed detail -> the subset of the spec this kind can actually observe. Keys absent
   *  from the projection are not diffed at all. */
  project(detail: Record<string, unknown>): Record<string, unknown>;
  /** Smallest honest impact mapping for an update, given which spec keys differ. */
  updateImpact(changedKeys: string[]): Impact;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;

  const aKeys = Object.keys(a as object).sort();
  const bKeys = Object.keys(b as object).sort();
  if (aKeys.length !== bKeys.length || aKeys.some((key, i) => key !== bKeys[i])) return false;

  return aKeys.every((key) =>
    deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

function target(kind: string, name: string, spec: Record<string, unknown>): Target {
  return { kind, name, spec };
}

/** The mechanical opposite of a change (#8). create <-> delete swap before/after; update
 *  swaps them too. There is no hand-written rollback logic anywhere else in the system. */
function invert(change: InverseChange): InverseChange {
  const op: PlanOp =
    change.op === "resource.create"
      ? "resource.delete"
      : change.op === "resource.delete"
        ? "resource.create"
        : "resource.update";

  return {
    op,
    target: change.target,
    before: change.after,
    after: change.before,
    // The inverse of a create is a delete: destroying what was just made is destructive
    // regardless of how cheap making it was.
    impact: op === "resource.delete" ? "destructive" : change.impact,
  };
}

export function makePlanner(rules: KindPlannerRules): Planner {
  /** The state to restore to: everything cockpit recorded, with the box's word taken as final
   *  on every field the box actually reports. */
  const reconstructBefore = (
    stored: Record<string, unknown> | null,
    detail: Record<string, unknown>,
  ) => ({ ...(stored ?? {}), ...rules.project(detail) });

  /** A change is reversible only if its `before` is a whole spec. An unmanaged resource
   *  observed through a partial projection is not — recreating from it would apply a spec the
   *  kind's own schema rejects, so the change says so instead of promising a rollback it
   *  cannot perform. */
  const withReversibility = (change: InverseChange): Change => {
    // A create's inverse restores nothing (it deletes), so it is always reversible. Update and
    // delete both restore `before`, which must therefore be a valid spec on its own.
    const restoreTo = change.before?.spec;
    if (restoreTo === undefined || rules.specSchema.safeParse(restoreTo).success) {
      return { ...change, inverse: invert(change), status: "pending" };
    }

    return {
      ...change,
      inverse: null,
      irreversible: {
        reason:
          "no complete prior spec to restore: this resource was not managed by cockpit before " +
          "now, and the daemon reports only part of its spec",
      },
      status: "pending",
    };
  };

  return ({ resourceId, kind, name, desired, stored, observed }) => {
    const present = observed?.exists === true;
    const detail = observed?.detail ?? {};

    if (desired === null) {
      if (!present) return [];

      return [
        withReversibility({
          op: "resource.delete",
          target: resourceId,
          before: target(kind, name, reconstructBefore(stored, detail)),
          after: null,
          impact: "destructive",
        }),
      ];
    }

    if (!present) {
      // A create needs no prior state to undo it — the inverse is "delete what was made".
      return [
        withReversibility({
          op: "resource.create",
          target: resourceId,
          before: null,
          after: target(kind, name, desired),
          impact: "restart",
        }),
      ];
    }

    // The diff itself uses ONLY what the box reports. `stored` cannot make a change appear or
    // disappear; it can only make the resulting `before` whole.
    //
    // NOTE, flagged in review: only keys present in `desired` are compared, so a kind with
    // optional spec fields will not plan field REMOVAL — dropping `healthcheck` from a spec
    // would read as "no change". `app` has no optional field today; the first kind that does
    // needs this loop to walk the union of both key sets.
    const projected = rules.project(detail);
    const changedKeys = Object.keys(projected).filter(
      (key) => key in desired && !deepEqual(desired[key], projected[key]),
    );
    if (changedKeys.length === 0) return [];

    return [
      withReversibility({
        op: "resource.update",
        target: resourceId,
        before: target(kind, name, reconstructBefore(stored, detail)),
        after: target(kind, name, desired),
        impact: rules.updateImpact(changedKeys),
      }),
    ];
  };
}
