// The kind registry (ADR-0006, #10). Adding a kind is a spec schema, a planner, and the probe
// whose word decides whether this kind was observed at all — plus a daemon handler on the
// other side of the wire. No new table, no new route, no new plan code: everything downstream
// reads the registry. test/plans.test.ts proves it by registering a kind and driving the real
// PUT route with it.

import { z } from "@hono/zod-openapi";
import { AppSpecSchema, appPlanner } from "./app";
import { makePlanner, type Planner } from "../plan/planner";

/** The daemon's per-probe outcome (type-design §3.1). A kind whose probe is `unavailable` was
 *  not observed, so its absence must not be read as deletion — or as room to create. */
export type ProbeKind = "docker" | "firewall" | "systemd" | "cron" | "host";

export interface KindEntry {
  specSchema: z.ZodType;
  planner: Planner;
  probe: ProbeKind;
}

/** Stub kinds: registered so the API, planner, and storage paths already accept them, with a
 *  permissive schema and a whole-spec diff. Each becomes real by replacing these fields — a
 *  tightened schema, and a planner declaring what the daemon observes for it. Until then a
 *  stub cannot diff anything (it observes nothing), so it only ever plans creates. */
const stub = (probe: ProbeKind): KindEntry => {
  const specSchema = z.record(z.string(), z.unknown());

  return {
    specSchema,
    planner: makePlanner({ specSchema, project: () => ({}), updateImpact: () => "replace" }),
    probe,
  };
};

export const KINDS: Record<string, KindEntry> = {
  app: { specSchema: AppSpecSchema, planner: appPlanner, probe: "docker" },
  database: stub("docker"),
  volume: stub("docker"),
  network: stub("docker"),
  proxy: stub("docker"),
  cron: stub("cron"),
  firewall_rule: stub("firewall"),
  daemon: stub("systemd"),
};

export function kindEntry(kind: string): KindEntry | undefined {
  return Object.hasOwn(KINDS, kind) ? KINDS[kind] : undefined;
}
