// docs/type-design.md §2.5 — the Change/Plan shapes, narrowed to what the planner slice
// produces. Apply (workflow_id, per-change status transitions, releases) is the next slice.

export type Impact = "none" | "reload" | "restart" | "replace" | "destructive";

/** The three ops the planner emits. The wider `Op` union in type-design §2.5 covers direct
 *  operations and server/link ops, which are not plans and not this slice. */
export type PlanOp = "resource.create" | "resource.update" | "resource.delete";

/** The resource a change acts on. The daemon holds no plane resource ids (#13), so it
 *  addresses the box by the `kind`/`name` it reads off a change's before/after — mirrors
 *  `Target` in daemon/internal/protocol/protocol.go, which is the wire truth. */
export interface Target {
  kind: string;
  name: string;
  spec: Record<string, unknown>;
}

/** A change's inverse: the same shape minus the recursion and minus apply-time bookkeeping. */
export interface InverseChange {
  op: PlanOp;
  target: string;
  before: Target | null;
  after: Target | null;
  impact: Impact;
}

export interface Change extends InverseChange {
  /** Every change carries an inverse or an `irreversible` reason (#8, invariant 2). */
  inverse: InverseChange | null;
  irreversible?: { reason: string };
  status: "pending" | "applied" | "failed" | "skipped";
}

/** The observed snapshot a diff is computed against (#7). Never last-known desired state. */
export interface Basis {
  observed_rev: number;
  observed_at: number | null;
}

export type Actor = { kind: "human" | "agent" | "system"; id: string };

const IMPACT_ORDER: Impact[] = ["none", "reload", "restart", "replace", "destructive"];

/** Derived, never accepted from a client (invariant 8). */
export function maxImpact(changes: Change[]): Impact {
  return changes.reduce<Impact>(
    (worst, change) =>
      IMPACT_ORDER.indexOf(change.impact) > IMPACT_ORDER.indexOf(worst) ? change.impact : worst,
    "none",
  );
}

export function summarise(changes: Change[], kind: string, name: string): string {
  if (changes.length === 0) return `no changes to ${kind}/${name}`;
  const ops = changes.map((change) => change.op.replace("resource.", "")).join(", ");
  return `${ops} ${kind}/${name}`;
}
