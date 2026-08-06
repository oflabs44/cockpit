// Unit tests for the planner as a pure function, and for the invariants of docs/type-design.md
// §5 that apply before apply exists: inverse coverage (2), diffing observed rather than
// last-known desired state (3), derived max_impact (8), determinism (10), kind extensibility
// (11), and no secret dereferencing (6).

import { describe, expect, it } from "vitest";
import { AppSpecSchema, appPlanner, appUpdateImpact } from "../src/kinds/app";
import { kindEntry } from "../src/kinds";
import { maxImpact } from "../src/plan/types";
import type { Change } from "../src/plan/types";

const SPEC = AppSpecSchema.parse({
  image: "ghcr.io/oflabs44/jerry:1.0.0",
  ports: [{ container: 8080, protocol: "tcp" }],
  env: { LOG_LEVEL: "info" },
  labels: { "traefik.enable": "true" },
  restart: "unless-stopped",
  limits: { cpu: "1", memory: "512m" },
});

function observedApp(overrides: Record<string, unknown> = {}) {
  return {
    exists: true,
    detail: {
      container_id: "abc123",
      image: SPEC.image,
      restart_policy: SPEC.restart,
      labels: SPEC.labels,
      ...overrides,
    },
  };
}

const req = (over: Partial<Parameters<typeof appPlanner>[0]> = {}) => ({
  resourceId: "res_1",
  kind: "app",
  name: "jerry",
  desired: SPEC as unknown as Record<string, unknown>,
  // A managed resource by default: cockpit recorded this spec before, so a complete `before`
  // can be reconstructed. Pass `stored: null` for the adopt-an-unmanaged-resource case.
  stored: SPEC as unknown as Record<string, unknown>,
  observed: observedApp(),
  ...over,
});

/** Asserts the planner produced exactly one change and hands it back. */
function only(changes: Change[]): Change {
  expect(changes).toHaveLength(1);

  return changes[0] as Change;
}

describe("planner: diffing", () => {
  it("plans a create when the box has never seen the resource", () => {
    const change = only(appPlanner(req({ observed: null })));

    expect(change.op).toBe("resource.create");
    expect(change.before).toBeNull();
    expect(change.after).toEqual({ kind: "app", name: "jerry", spec: SPEC });
    expect(change.impact).toBe("restart");
  });

  it("produces no changes when desired matches observed", () => {
    expect(appPlanner(req())).toEqual([]);
  });

  it("plans a replace when the observed image differs", () => {
    const change = only(appPlanner(req({ observed: observedApp({ image: "ghcr.io/x:0.9.0" }) })));

    expect(change.op).toBe("resource.update");
    expect(change.impact).toBe("replace");
    expect(change.before?.spec.image).toBe("ghcr.io/x:0.9.0");
    expect(change.after?.spec.image).toBe(SPEC.image);
  });

  it("plans a restart, not a replace, when only labels differ", () => {
    const change = only(
      appPlanner(req({ observed: observedApp({ labels: { "traefik.enable": "false" } }) })),
    );

    expect(change.impact).toBe("restart");
  });

  it("plans a destructive delete when desired is null", () => {
    const change = only(appPlanner(req({ desired: null })));

    expect(change.op).toBe("resource.delete");
    expect(change.impact).toBe("destructive");
    expect(change.after).toBeNull();
  });

  // Invariant 3 (#7): the same desired spec against a CHANGED observed state must produce a
  // different plan. This is the drift test — a resource altered out-of-band is described, not
  // silently accepted because the plane's last-known desired state still matches.
  it("produces a different plan when observed state changed underneath it", () => {
    const before = appPlanner(req());
    const after = appPlanner(req({ observed: observedApp({ image: "ghcr.io/x:drifted" }) }));

    expect(before).toEqual([]);
    expect(after).toHaveLength(1);
    expect(after).not.toEqual(before);
  });

  it("is deterministic: same input, same output, no clock or randomness", () => {
    expect(appPlanner(req({ observed: null }))).toEqual(appPlanner(req({ observed: null })));
  });
});

describe("planner: invariants", () => {
  // Invariant 2 (#8), stated semantically rather than structurally: "has an inverse field" is
  // worth nothing. What must hold is that applying a change and then applying its inverse
  // returns the resource to the spec it started from, and that BOTH directions are specs the
  // kind's own schema accepts — an inverse that cannot be applied is not a rollback.
  it("round-trips: applying a change then its inverse restores the original spec", () => {
    const original = AppSpecSchema.parse({ ...SPEC, image: "ghcr.io/oflabs44/jerry:0.9.0" });
    const desired = AppSpecSchema.parse({ ...SPEC, env: { LOG_LEVEL: "debug" } });

    // The box is running `original`; cockpit has `original` stored; the operator wants `desired`.
    const change = only(
      appPlanner(
        req({
          desired: desired as unknown as Record<string, unknown>,
          stored: original as unknown as Record<string, unknown>,
          observed: observedApp({ image: original.image }),
        }),
      ),
    );

    // Forward: `after` is the spec the daemon would apply. It must be whole and valid.
    expect(AppSpecSchema.safeParse(change.after?.spec).success).toBe(true);
    expect(change.after?.spec).toEqual(desired);

    // Backward: the inverse's `after` is what a rollback would apply. Also whole, also valid,
    // and equal to what was there before — including the env/ports/limits the daemon never
    // reported, which is exactly what the observed-only `before` used to drop on the floor.
    const restored = change.inverse?.after?.spec;
    expect(AppSpecSchema.safeParse(restored).success).toBe(true);
    expect(restored).toEqual(original);
  });

  it("round-trips a delete: its inverse recreates the full stored spec", () => {
    const change = only(appPlanner(req({ desired: null })));

    expect(change.inverse?.op).toBe("resource.create");
    expect(AppSpecSchema.safeParse(change.inverse?.after?.spec).success).toBe(true);
    expect(change.inverse?.after?.spec).toEqual(SPEC);
  });

  it("lets the observed value win over the stored one when reconstructing before", () => {
    const change = only(
      appPlanner(req({ observed: observedApp({ image: "ghcr.io/x:hand-rolled" }) })),
    );

    // The box's word on a field the box reports; the stored spec's word on the rest.
    expect(change.before?.spec.image).toBe("ghcr.io/x:hand-rolled");
    expect(change.before?.spec.limits).toEqual(SPEC.limits);
  });

  // Adopting an unmanaged resource: no stored spec, and the daemon reports only part of one.
  // There is nothing to roll back TO, so the change must say so rather than carry an inverse
  // that would apply a spec the schema rejects.
  it("declares itself irreversible when there is no complete prior spec", () => {
    const change = only(
      appPlanner(
        req({ stored: null, observed: observedApp({ image: "ghcr.io/x:already-running" }) }),
      ),
    );

    expect(change.op).toBe("resource.update");
    expect(change.inverse).toBeNull();
    expect(change.irreversible?.reason).toMatch(/not managed by cockpit/);
    // The partial `before` really is unusable as a spec — that is why.
    expect(AppSpecSchema.safeParse(change.before?.spec).success).toBe(false);
  });

  it("still reverses a delete of an unmanaged resource only if the projection is whole", () => {
    const change = only(appPlanner(req({ stored: null, desired: null })));

    expect(change.op).toBe("resource.delete");
    expect(change.inverse).toBeNull();
    expect(change.irreversible).toBeDefined();
  });

  it("makes the inverse of a create a destructive delete carrying the create's after", () => {
    const change = only(appPlanner(req({ observed: null })));

    expect(change.inverse).toEqual({
      op: "resource.delete",
      target: "res_1",
      before: change.after,
      after: null,
      impact: "destructive",
    });
  });

  it("makes the inverse of a delete a create whose after is the delete's before", () => {
    const change = only(appPlanner(req({ desired: null })));

    expect(change.inverse?.op).toBe("resource.create");
    expect(change.inverse?.after).toEqual(change.before);
    expect(change.inverse?.before).toBeNull();
  });

  it("inverts an update by swapping before and after", () => {
    const change = only(appPlanner(req({ observed: observedApp({ image: "ghcr.io/x:0.9.0" }) })));

    expect(change.inverse?.op).toBe("resource.update");
    expect(change.inverse?.before).toEqual(change.after);
    expect(change.inverse?.after).toEqual(change.before);
  });

  // The daemon holds no plane resource ids and addresses the box by the kind/name it reads off
  // a change's before/after (daemon/README.md protocol notes, protocol.go `Target`).
  it("carries kind and name on every before/after the daemon will read", () => {
    const changes = [
      ...appPlanner(req({ observed: null })),
      ...appPlanner(req({ observed: observedApp({ image: "ghcr.io/x:0.9.0" }) })),
      ...appPlanner(req({ desired: null })),
    ];

    for (const change of changes) {
      for (const side of [change.before, change.after]) {
        if (side === null) continue;
        expect(side.kind).toBe("app");
        expect(side.name).toBe("jerry");
      }
    }
  });

  // Invariant 8: max_impact is derived from the changes, never supplied.
  it("derives max_impact as the worst impact present", () => {
    expect(maxImpact([])).toBe("none");
    expect(maxImpact(appPlanner(req({ observed: null })))).toBe("restart");
    expect(maxImpact(appPlanner(req({ desired: null })))).toBe("destructive");
  });

  it("maps update impact from the changed keys and nothing else", () => {
    expect(appUpdateImpact(["env"])).toBe("restart");
    expect(appUpdateImpact(["labels", "restart"])).toBe("restart");
    expect(appUpdateImpact(["env", "image"])).toBe("replace");
    expect(appUpdateImpact(["ports"])).toBe("replace");
    expect(appUpdateImpact(["limits"])).toBe("replace");
  });
});

describe("AppSpec schema", () => {
  // Invariant 6 (ADR-0008): a secret ref is data. It is stored exactly as written, and there
  // is no code path in the plane that dereferences one.
  it("stores an op:// env ref verbatim, unresolved and unexpanded", () => {
    const ref = "op://cockpit/jerry/DATABASE_URL";
    const parsed = AppSpecSchema.parse({ ...SPEC, env: { DATABASE_URL: ref, LOG_LEVEL: "info" } });

    expect(parsed.env.DATABASE_URL).toBe(ref);

    const change = only(
      appPlanner(req({ desired: parsed as unknown as Record<string, unknown>, observed: null })),
    );
    expect((change.after?.spec.env as Record<string, string>).DATABASE_URL).toBe(ref);
    // Serialised for storage and for the wire: still the ref, still nothing resolved.
    expect(JSON.stringify(change)).toContain(ref);
  });

  it("requires an image and explicit limits", () => {
    expect(AppSpecSchema.safeParse({ ...SPEC, image: "" }).success).toBe(false);
    expect(AppSpecSchema.safeParse({ image: "x", limits: undefined }).success).toBe(false);
  });
});

// Invariant 11 (adding a kind touches the registry and the daemon, nothing else) is tested
// end-to-end in test/plans.test.ts, driving the real PUT route with a kind registered at
// runtime — calling the planner directly here would prove nothing about the route or the table.
describe("kind registry", () => {
  it("rejects a kind that is not registered", () => {
    expect(kindEntry("not_a_kind")).toBeUndefined();
  });
});
