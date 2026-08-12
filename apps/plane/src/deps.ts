// docs/type-design.md §1 — "No Date.now() or Math.random() in plane logic": clock and id
// generation are injected so deployments and operations are replayable and testable. This is
// the one seam where real time and randomness exist for edge wiring.

export interface Deps {
  clock: { now(): number };
  ids: { id(prefix: string): string };
}

export const realDeps: Deps = {
  clock: { now: () => Date.now() },
  ids: { id: (prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}` },
};
