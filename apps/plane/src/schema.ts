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
