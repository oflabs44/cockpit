// docs/type-design.md §1 — "No Date.now() or Math.random() in plane logic": clock and id
// generation are injected so plans and workflows are replayable and testable. This is the
// one seam where real time/randomness is allowed to exist, for wiring at the edge.

export interface Clock {
  now(): number;
}

export interface IdGen {
  id(prefix: string): string;
}

export const realClock: Clock = {
  now: () => Date.now(),
};

export const realIdGen: IdGen = {
  id: (prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`,
};

export interface Deps {
  clock: Clock;
  ids: IdGen;
}

export const realDeps: Deps = { clock: realClock, ids: realIdGen };
