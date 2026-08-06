// The `app` kind. Spec fields match the daemon's slice of AppSpec in
// daemon/internal/protocol/protocol.go (image, ports, env, labels, restart, limits) — that
// file is the wire truth, so this schema tracks it rather than type-design §2.3's fuller
// AppSpec (source/build/domains/replicas/healthcheck arrive with the build slice).

import { z } from "@hono/zod-openapi";
import { makePlanner } from "../plan/planner";
import type { Impact } from "../plan/types";

/** A plain value or a provider-scheme secret ref (`op://…`). Stored EXACTLY as given: the
 *  plane never resolves, expands, or logs one — the daemon resolves it on the box,
 *  immediately before use (#15, ADR-0008). There is deliberately no code path here that
 *  dereferences a ref, and invariant 6 is the test that says so. */
export const EnvValueSchema = z.string();

export const AppSpecSchema = z.object({
  image: z.string().min(1),
  ports: z
    .array(
      z.object({
        container: z.number().int().positive(),
        host: z.number().int().positive().optional(),
        protocol: z.enum(["tcp", "udp"]).default("tcp"),
      }),
    )
    .default([]),
  env: z.record(z.string(), EnvValueSchema).default({}),
  labels: z.record(z.string(), z.string()).default({}),
  restart: z.enum(["always", "unless-stopped", "on-failure"]).default("unless-stopped"),
  // Required, not defaulted: builds and containers run on the box the operator depends on
  // (#17), so "unbounded" is never the accidental answer.
  limits: z.object({ cpu: z.string().min(1), memory: z.string().min(1) }),
});

export type AppSpec = z.infer<typeof AppSpecSchema>;

/** Spec keys whose change means the container must be recreated rather than restarted.
 *  Docker cannot change an image, a port binding, or a cgroup limit in place. */
const REPLACE_KEYS = new Set(["image", "ports", "limits"]);

/** Smallest honest mapping (#16 — impact is data, not documentation):
 *    image / ports / limits changed -> `replace` (new container)
 *    env / labels / restart changed -> `restart` (same container, new process state)
 *  Nothing here is `none` or `reload`: this kind has no field the daemon can change without
 *  the process noticing. */
export function appUpdateImpact(changedKeys: string[]): Impact {
  return changedKeys.some((key) => REPLACE_KEYS.has(key)) ? "replace" : "restart";
}

/** What the daemon's docker observer actually reports for a container
 *  (daemon/internal/observer/observer.go): container_id, image, image_digest, state, status,
 *  labels, created_at, started_at, restart_count, restart_policy. Only `image`, `labels` and
 *  `restart_policy` correspond to spec fields, so only those three can be diffed today —
 *  env, ports and limits are not observed and therefore cannot produce a change. */
export function projectAppObserved(detail: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  if (typeof detail.image === "string") projected.image = detail.image;
  if (typeof detail.restart_policy === "string") projected.restart = detail.restart_policy;
  if (detail.labels && typeof detail.labels === "object") projected.labels = detail.labels;

  return projected;
}

export const appPlanner = makePlanner({
  specSchema: AppSpecSchema,
  project: projectAppObserved,
  updateImpact: appUpdateImpact,
});
