// Zod schemas define the plane's public model. REST and MCP routes must derive from these
// schemas so that each capability has one boundary definition (ADR-0005).

import { z } from "@hono/zod-openapi";

export const ActorSchema = z.object({
  kind: z.enum(["human", "agent", "system"]),
  id: z.string(),
});

export type Actor = z.infer<typeof ActorSchema>;

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

// docs/type-design.md §3.1 `ObservedHost` contains raw host facts. Plane policy applies health
// thresholds later. This schema must not interpret a value from the daemon.
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

export const ProjectSchema = z.object({
  id: z.string(),
  server_id: z.string(),
  name: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
});

export type Project = z.infer<typeof ProjectSchema>;

export const HealthSchema = z.enum([
  "healthy",
  "degraded",
  "unhealthy",
  "stopped",
  "unknown",
]);

export const ResourceKindSchema = z.enum([
  "app",
  "database",
  "proxy",
  "volume",
  "network",
  "cron",
  "daemon",
  "firewall_rule",
  "domain",
  "dns_record",
  "source",
  "secret",
  "secret_provider",
  "backup_destination",
]);

export const ConfigurationSchema = z.record(z.string(), z.unknown());

export const ObservedSchema = z.object({
  exists: z.boolean(),
  health: HealthSchema,
  detail: z.record(z.string(), z.unknown()),
  observed_at: z.number(),
});

export const ResourceSchema = z
  .object({
    id: z.string(),
    server_id: z.string().nullable(),
    project_id: z.string().nullable(),
    kind: ResourceKindSchema,
    name: z.string(),
    configuration: ConfigurationSchema,
    configuration_version: z.number().int().positive(),
    current_release_id: z.string().nullable(),
    health: HealthSchema,
    exposed_at: z.string().nullable(),
    drifted: z.boolean(),
    observed: ObservedSchema.nullable(),
    observed_rev: z.number().int().nonnegative(),
    observed_at: z.number().nullable(),
    created_at: z.number(),
    updated_at: z.number(),
  })
  .refine(
    (resource) => resource.project_id === null || resource.server_id !== null,
    { message: "a project-owned resource must belong to a server" },
  )
  .refine(
    (resource) =>
      resource.kind !== "app" ||
      (resource.server_id !== null && resource.project_id !== null),
    { message: "an app must belong to a server and project" },
  );

export type Resource = z.infer<typeof ResourceSchema>;

export const SourceRevisionSchema = z.object({
  ref: z.string(),
  commit: z.string(),
  message: z.string().nullable(),
});

export type SourceRevision = z.infer<typeof SourceRevisionSchema>;

export const ImpactSchema = z.enum(["none", "reload", "restart", "replace", "destructive"]);

export const ChangeSchema = z.object({
  action: z.enum(["create", "update", "replace", "delete"]),
  target: z.string(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  impact: ImpactSchema,
  result: z.enum(["pending", "applied", "failed", "skipped"]),
  error: z.object({ kind: z.string(), message: z.string() }).optional(),
});

export const ChangeSetSchema = z.object({
  basis: z.record(z.string(), z.number().int().nonnegative()),
  changes: z.array(ChangeSchema),
  max_impact: ImpactSchema,
  calculated_at: z.number(),
});

export type ChangeSet = z.infer<typeof ChangeSetSchema>;

export const DeploymentTriggerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("git_push"),
    source_id: z.string(),
    revision: SourceRevisionSchema,
    delivery_id: z.string(),
  }),
  z.object({ kind: z.literal("manual"), commit: z.string().nullable() }),
  z.object({ kind: z.literal("redeploy"), deployment_id: z.string() }),
  z.object({ kind: z.literal("rollback"), release_id: z.string() }),
]);

export type DeploymentTrigger = z.infer<typeof DeploymentTriggerSchema>;

export const DeploymentStatusSchema = z.enum([
  "queued",
  "fetching",
  "building",
  "planning",
  "deploying",
  "checking",
  "succeeded",
  "failed",
  "cancelled",
]);

export const DeploymentStepSchema = z.object({
  name: z.enum(["source", "build", "changes", "apply", "healthcheck"]),
  status: z.enum(["pending", "running", "succeeded", "failed", "skipped"]),
  started_at: z.number().nullable(),
  finished_at: z.number().nullable(),
  error: z.object({ kind: z.string(), message: z.string() }).nullable(),
});

export type DeploymentStep = z.infer<typeof DeploymentStepSchema>;

export const DeploymentSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  app_id: z.string(),
  server_id: z.string(),
  trigger: DeploymentTriggerSchema,
  triggered_by: ActorSchema,
  status: DeploymentStatusSchema,
  source_revision: SourceRevisionSchema.nullable(),
  configuration_snapshot: ConfigurationSchema,
  configuration_version: z.number().int().positive(),
  steps: z.array(DeploymentStepSchema),
  changes: ChangeSetSchema.nullable(),
  workflow_id: z.string(),
  release_id: z.string().nullable(),
  created_at: z.number(),
  started_at: z.number().nullable(),
  finished_at: z.number().nullable(),
});

export type Deployment = z.infer<typeof DeploymentSchema>;

export const OperationKindSchema = z.enum([
  "resource.apply",
  "resource.rollback",
  "resource.delete",
  "resource.start",
  "resource.stop",
  "resource.restart",
  "resource.exec",
  "server.drain",
  "server.forget",
  "daemon.upgrade",
]);

export const OperationStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const OperationSchema = z.object({
  id: z.string(),
  server_id: z.string(),
  project_id: z.string().nullable(),
  resource_id: z.string().nullable(),
  kind: OperationKindSchema,
  actor: ActorSchema,
  status: OperationStatusSchema,
  configuration_snapshot: ConfigurationSchema.nullable(),
  changes: ChangeSetSchema.nullable(),
  workflow_id: z.string().nullable(),
  release_id: z.string().nullable(),
  created_at: z.number(),
  started_at: z.number().nullable(),
  finished_at: z.number().nullable(),
});

export type Operation = z.infer<typeof OperationSchema>;

export const ReleaseSchema = z
  .object({
    id: z.string(),
    resource_id: z.string(),
    rev: z.number().int().positive(),
    deployment_id: z.string().nullable(),
    operation_id: z.string().nullable(),
    configuration_snapshot: ConfigurationSchema,
    runtime_snapshot: z.record(z.string(), z.unknown()),
    source_revision: SourceRevisionSchema.nullable(),
    image_digest: z.string().nullable(),
    restored_from_release_id: z.string().nullable(),
    status: z.enum(["active", "superseded"]),
    created_at: z.number(),
  })
  .refine(
    (release) => (release.deployment_id === null) !== (release.operation_id === null),
    { message: "a release must have exactly one deployment or operation origin" },
  );

export type Release = z.infer<typeof ReleaseSchema>;

export const EventSchema = z.object({
  id: z.string(),
  server_id: z.string().nullable(),
  project_id: z.string().nullable(),
  resource_id: z.string().nullable(),
  deployment_id: z.string().nullable(),
  operation_id: z.string().nullable(),
  type: z.string(),
  actor: ActorSchema,
  payload: z.record(z.string(), z.unknown()),
  at: z.number(),
});

export type Event = z.infer<typeof EventSchema>;

// ADR-0010 — a Source is a mirrored GitHub App installation, not daemon configuration.
export const SourceProviderSchema = z.enum(["github"]);

export const RepositorySelectionSchema = z.enum(["all", "selected"]);

// Field names match apps/web/src/api/sources.ts, the web's hand-written subset of this
// contract — `github_login` / `github_installation_id` are prefixed there so a future
// provider's fields don't collide.
export const SourceSchema = z.object({
  id: z.string(),
  provider: SourceProviderSchema,
  name: z.string(), // display name; defaults to the login at connect time
  github_login: z.string(),
  github_installation_id: z.number().int().positive(),
  account_id: z.number().int().nullable(),
  repository_selection: RepositorySelectionSchema,
  permissions: z.record(z.string(), z.string()),
  events: z.array(z.string()),
  created_at: z.number(),
  updated_at: z.number(),
});

export type Source = z.infer<typeof SourceSchema>;

export const SourceListResponse = z.object({ sources: z.array(SourceSchema) });

export const ConnectGitHubResponse = z.object({
  // Where the operator's browser goes to install the configured GitHub App.
  url: z.string(),
  state: z.string(), // echoed through GitHub's redirect; opaque
});

export const ResourceListResponse = z.object({ resources: z.array(ResourceSchema) });
export const ErrorResponse = z.object({ error: z.string() });
