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

export const ServerDetailResponse = z.object({
  server: ServerSchema,
  observed: z
    .object({
      rev: z.number(),
      resources: z.array(z.unknown()),
    })
    .nullable(),
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
