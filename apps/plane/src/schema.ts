// Zod payload schemas for the enrolment slice. docs/type-design.md §0: these belong in
// `packages/schema` as the single definition REST/MCP/UI all derive from — TODO: extract
// once a second consumer (MCP tools, web forms) needs them. Kept local for now.

import { z } from "@hono/zod-openapi";

export const ServerStatus = z.enum(["enrolling", "connected", "disconnected", "draining"]);

export const ServerSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.enum(["hetzner", "digitalocean", "linode", "other"]),
  addr: z.string().nullable(),
  arch: z.string().nullable(),
  status: ServerStatus,
  agent_version: z.string().nullable(),
  last_seen_at: z.number().nullable(),
  labels: z.record(z.string(), z.string()),
  created_at: z.number(),
});

export const CreateServerBody = z.object({
  name: z.string().min(1),
  provider: z.enum(["hetzner", "digitalocean", "linode", "other"]),
  labels: z.record(z.string(), z.string()).default({}),
});

export const CreateServerResponse = z.object({
  server: ServerSchema,
  token: z.string(), // shown once
  install_command: z.string(),
});

// docs/type-design.md §3.1 `ObservedHost` (added 2026-08-06) — raw host-level facts, mirrored
// from daemon/internal/protocol/protocol.go's ObservedHost. No thresholds here: what counts as
// "full" or "unsafe" is plane policy, a later slice.
export const ObservedHostSchema = z.object({
  identity: z.object({
    os: z.string(),
    kernel: z.string(),
    hostname: z.string(),
    uptime_s: z.number(),
  }),
  capacity: z.object({
    cpus: z.number(),
    mem_total: z.number(),
    swap_total: z.number(),
    disks: z.array(z.object({ mount: z.string(), size: z.number(), used: z.number() })),
  }),
  load: z.tuple([z.number(), z.number(), z.number()]),
  listeners: z.array(
    z.object({ proto: z.string(), addr: z.string(), port: z.number(), pid_name: z.string() }),
  ),
  security: z.object({
    sshd: z.object({
      permit_root_login: z.string(),
      password_authentication: z.string(),
      max_auth_tries: z.number(),
    }),
    fail2ban_active: z.boolean(),
    unattended_upgrades_active: z.boolean(),
    last_apt_activity_unix: z.number(),
  }),
});

const ProbeKind = z.enum(["docker", "firewall", "systemd", "cron", "host"]);
const ProbeStatus = z.enum(["ok", "unavailable"]);
// Not every kind is necessarily reported every snapshot (type-design §3.1: absence reads as
// unknown, not deletion) — `partialRecord`, not `record`, so the schema doesn't demand all five.
export const ProbesSchema = z.partialRecord(ProbeKind, ProbeStatus);

export const ServerDetailResponse = z.object({
  server: ServerSchema,
  observed: z
    .object({
      rev: z.number(),
      resources: z.array(z.unknown()),
    })
    .nullable(),
  host: ObservedHostSchema.nullable(),
  probes: ProbesSchema.nullable(),
});

export const EnrolmentSchema = z.object({
  id: z.string(),
  server_id: z.string().nullable(),
  mode: z.enum(["token", "claim_code"]),
  presented: z
    .object({
      hostname: z.string(),
      arch: z.string(),
      addr: z.string(),
      agent_version: z.string(),
    })
    .nullable(),
  expires_at: z.number(),
  created_at: z.number(),
});

export const RedeemResponse = z.object({
  server: ServerSchema,
});

// docs/type-design.md §2.2 / §2.5 — resources and plans.

export const ActorSchema = z.object({
  kind: z.enum(["human", "agent", "system"]),
  id: z.string(),
});

export const ResourceSchema = z.object({
  id: z.string(),
  server_id: z.string().nullable(),
  project_id: z.string().nullable(),
  kind: z.string(),
  name: z.string(),
  spec: z.record(z.string(), z.unknown()),
  created_at: z.number(),
  updated_at: z.number(),
});

const TargetSchema = z.object({
  kind: z.string(),
  name: z.string(),
  spec: z.record(z.string(), z.unknown()),
});

export const ImpactSchema = z.enum(["none", "reload", "restart", "replace", "destructive"]);

const InverseChangeSchema = z.object({
  op: z.enum(["resource.create", "resource.update", "resource.delete"]),
  target: z.string(),
  before: TargetSchema.nullable(),
  after: TargetSchema.nullable(),
  impact: ImpactSchema,
});

export const ChangeSchema = InverseChangeSchema.extend({
  inverse: InverseChangeSchema.nullable(),
  irreversible: z.object({ reason: z.string() }).optional(),
  status: z.enum(["pending", "applied", "failed", "skipped"]),
});

export const PlanStatus = z.enum([
  "pending",
  "approved",
  "rejected",
  "applying",
  "applied",
  "failed",
  "reverted",
]);

export const PlanSchema = z.object({
  // Null for a no-op plan: an empty diff is returned transiently and never persisted, so it
  // has no id to give (see src/routes/resources-upsert.ts).
  id: z.string().nullable(),
  server_id: z.string(),
  resource_id: z.string(),
  status: PlanStatus,
  changes: z.array(ChangeSchema),
  basis: z.object({ observed_rev: z.number(), observed_at: z.number().nullable() }),
  summary: z.string(),
  max_impact: ImpactSchema, // derived, never accepted from a client (invariant 8)
  created_by: ActorSchema,
  decided_by: ActorSchema.nullable(),
  /** Spec keys that differ from the stored spec but that this kind cannot observe, so they
   *  produced no change. Empty is the normal case; non-empty means "you asked for something
   *  cockpit cannot yet see, and therefore cannot plan". */
  undiffable_keys: z.array(z.string()),
  created_at: z.number(),
  decided_at: z.number().nullable(),
  approved_at: z.number().nullable(),
});

/** A plan whose stored record could not be trusted. Deliberately carries no changes, basis, or
 *  actor: a corrupt audit record must read as unreadable, never as an empty, harmless plan. */
export const CorruptPlanSchema = z.object({
  id: z.string(),
  server_id: z.string(),
  resource_id: z.string(),
  corrupt: z.literal(true),
  summary: z.string(),
  created_at: z.number(),
});

export const UpsertResourceBody = z.object({
  // Optional, not defaulted to null: an absent field must not silently clear a resource's
  // project on every subsequent PUT.
  project_id: z.string().nullable().optional(),
  // Validated against the kind's schema from the registry, not here: one definition per kind
  // (ADR-0006). This route-level schema only says "an object arrived".
  spec: z.record(z.string(), z.unknown()),
});

export const PlanResponse = z.object({ plan: PlanSchema });
export const PlanListResponse = z.object({
  plans: z.array(z.union([PlanSchema, CorruptPlanSchema])),
});
export const ResourceListResponse = z.object({ resources: z.array(ResourceSchema) });
export const ErrorResponse = z.object({ error: z.string() });
