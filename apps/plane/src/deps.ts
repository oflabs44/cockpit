// docs/type-design.md §1 — "No Date.now() or Math.random() in plane logic": clock and id
// generation are injected so plans and workflows are replayable and testable. This is the
// one seam where real time/randomness is allowed to exist, for wiring at the edge.

export interface Deps {
  clock: { now(): number };
  ids: { id(prefix: string): string };
}

export const realDeps: Deps = {
  clock: { now: () => Date.now() },
  ids: { id: (prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}` },
};
