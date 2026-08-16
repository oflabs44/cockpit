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

// ADR-0012 / docs/type-design.md §2.2–§2.4. Git owns the workload topology; the plane owns
// only the target-specific bindings below. No Compose service definition is stored here.

// A Compose service key, as it appears in the repository's Compose file.
const ComposeServiceName = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "not a Compose service name")
  .max(63);

// A variable value is ordinarily a literal the daemon passes through — `production`, a
// `https://` callback, a `redis://` address — or a pointer to a secret, never the secret
// itself (docs/type-design.md §1). Only the SecretRef schemes type-design reserves for a
// later resolver are refused: storing one would promise a dereference at apply time that
// the daemon cannot perform. `op://` is the one v1 resolves.
//
// Case-insensitive because a scheme is, and `AWS://` must not be the way past this.
const RESERVED_SECRET_SCHEMES = ["aws://", "vault://", "ck://"] as const;

const VariableValueSchema = z.string().refine(
  (value) =>
    !RESERVED_SECRET_SCHEMES.some((scheme) => value.toLowerCase().startsWith(scheme)),
  {
    message: `${RESERVED_SECRET_SCHEMES.join(", ")} secret references are reserved but not resolvable yet; v1 resolves op://`,
  },
);

const EnvironmentName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "not an env var name");

// A hostname; deliberately not a URL — Traefik routes a host, not a path.
const DomainSchema = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, "not a domain")
  .max(253);

export const ProjectSettingsSchema = z.object({
  ingress: z
    .object({
      service: ComposeServiceName,
      port: z.number().int().min(1).max(65535),
      domains: z.array(DomainSchema).min(1),
    })
    .strict()
    .nullable(),
  migration: z
    .object({
      service: ComposeServiceName,
      // Absent: use the service's own Compose command.
      command: z.array(z.string().min(1)).min(1).optional(),
    })
    .strict()
    .nullable(),
  health: z.object({ required_services: z.array(ComposeServiceName) }).strict(),
  variables: z.record(EnvironmentName, VariableValueSchema),
})
  // Strict: a Compose service definition must never reach the plane through settings.
  .strict();

export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

// A path inside the repository: relative, no traversal, no absolute or Windows separators.
const RepositoryPath = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9._\-/]+$/, "not a repository path")
  .refine((value) => !value.startsWith("/") && !value.endsWith("/"), {
    message: "must be relative to the repository root",
  })
  .refine((value) => !value.split("/").includes(".."), { message: "must not traverse upwards" });

export const ProjectSourceBinding = {
  source_id: z.string().min(1),
  // GitHub's numeric repository id, held as text: it outlives a rename, and text keeps the
  // column provider-neutral without losing precision on a large id. This is the
  // authoritative identity of the repository a Project deploys from — see
  // `repository_full_name` below and docs/type-design.md §2.2.
  repository_id: z.string().regex(/^[0-9]+$/, "not a repository id"),
  // A display cache, not an identity: the operator recognises a Project by it, and it goes
  // stale the moment the repository is renamed or transferred on github.com. Nothing may
  // clone, fetch, or authorize by this field; the fetch/preflight slice resolves the current
  // clone identity from `repository_id`.
  repository_full_name: z
    .string()
    .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, "not an owner/repository name"),
  // A branch or tag name. Git's own rules, reduced to what a deployable ref looks like.
  ref: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9._\-/]+$/, "not a git ref")
    .refine((value) => !value.split("/").includes("..") && !value.endsWith(".lock"), {
      message: "not a git ref",
    })
    // A leading dash is not a name git will accept, and it is the shape that reads as an
    // option to every command the ref is later handed to — refused at the boundary rather
    // than relied on being quoted correctly by each caller.
    .refine((value) => !value.startsWith("-"), { message: "a git ref must not begin with -" }),
  // "." is the repository root.
  base_directory: z.union([z.literal("."), RepositoryPath]),
  // Relative to base_directory.
  compose_path: RepositoryPath.refine(
    (value) => value.endsWith(".yaml") || value.endsWith(".yml"),
    { message: "must be a .yaml or .yml file" },
  ),
  auto_deploy: z.boolean(),
} as const;

export const ProjectSchema = z
  .object({
    id: z.string(),
    server_id: z.string(),
    name: z.string(),
    // Null on projects created before ADR-0012 and by POST /projects. An imported project
    // carries the whole binding or none of it.
    source_id: ProjectSourceBinding.source_id.nullable(),
    repository_id: ProjectSourceBinding.repository_id.nullable(),
    repository_full_name: ProjectSourceBinding.repository_full_name.nullable(),
    ref: ProjectSourceBinding.ref.nullable(),
    base_directory: ProjectSourceBinding.base_directory.nullable(),
    compose_path: ProjectSourceBinding.compose_path.nullable(),
    auto_deploy: z.boolean(),
    settings: ProjectSettingsSchema,
    created_at: z.number(),
    updated_at: z.number(),
  })
  .refine(
    (project) => {
      const binding = [
        project.source_id,
        project.repository_id,
        project.repository_full_name,
        project.ref,
        project.base_directory,
        project.compose_path,
      ];
      if (binding.every((field) => field !== null)) return true;

      // Unbound: there is no repository, ref, or Compose file to deploy, so `auto_deploy`
      // has nothing it could act on. A true here would describe a project that reacts to
      // pushes it can never receive.
      return binding.every((field) => field === null) && project.auto_deploy === false;
    },
    {
      message:
        "a project's source binding must be complete or absent, and an unbound project cannot auto-deploy",
    },
  );

export type Project = z.infer<typeof ProjectSchema>;

export const EMPTY_PROJECT_SETTINGS: ProjectSettings = {
  ingress: null,
  migration: null,
  health: { required_services: [] },
  variables: {},
};

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

// Deployment log transport (ADR-0012). Mirrors `StreamData` in
// daemon/internal/protocol/protocol.go, which is authoritative for the wire names.

export const DeploymentLogStageSchema = z.enum([
  "fetch",
  "normalize",
  "build",
  "migrate",
  "apply",
  "health",
]);

/** `system` is the daemon narrating its own steps — neither of the child process's streams. */
export const DeploymentLogSourceSchema = z.enum(["stdout", "stderr", "system"]);

/** Matches `protocol.MaxLogChunkBytes`. One unbounded line must not become one huge frame. */
export const MAX_LOG_CHUNK_BYTES = 8192;

/**
 * The limit is bytes, as Go's `len()` counts them — not JavaScript characters. A string of
 * 8192 emoji is 8192 `.length` and 32768 bytes on the wire, so a character-counting check
 * would admit four times the payload the daemon's own limit allows and quietly blow the
 * storage bound the tail is sized against.
 */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * One chunk of a deployment's live output, as the daemon sends it.
 *
 * `stream_id` IS the Deployment id — the plane authorizes the frame, looks the deployment
 * up, and addresses its StreamDO by this one value. The frame carries no second copy of it:
 * two fields naming the same thing can disagree, and then the plane has to pick which half
 * of a self-contradicting frame to believe.
 *
 * This is a closed schema and that is the security property, not a formality: zod strips
 * every key it does not name, so a daemon that appends `env`, `token`, or any other
 * metadata field to the frame cannot get it persisted in the replay tail or fanned out to a
 * browser. Resolved environment values and GitHub installation tokens never leave the box
 * (ADR-0012), and nothing here provides a channel for them.
 *
 * Loss-aware by construction: `seq` is monotonic per stream as the daemon produced it, and
 * `dropped` counts what the daemon discarded before this chunk. A jump in `seq` with a
 * non-zero `dropped` is legitimate and means output is missing — a reader says so rather
 * than rendering a silent hole. `final` is the terminal marker; see StreamDO's archive seam.
 */
export const StreamDataFrameSchema = z.object({
  type: z.literal("stream_data"),
  stream_id: z.string().min(1).max(128),
  seq: z.number().int().nonnegative(),
  stage: DeploymentLogStageSchema,
  source: DeploymentLogSourceSchema,
  data: z.string().refine((value) => utf8ByteLength(value) <= MAX_LOG_CHUNK_BYTES, {
    message: `data exceeds ${MAX_LOG_CHUNK_BYTES} utf-8 bytes`,
  }),
  at: z.number().int().positive(),
  dropped: z.number().int().nonnegative().default(0),
  final: z.boolean().default(false),
});

export type StreamDataFrame = z.infer<typeof StreamDataFrameSchema>;

/** What a subscriber receives: the frame minus its wire discriminator. */
export type DeploymentLogEntry = Omit<StreamDataFrame, "type">;

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
  // The App this installation belongs to. Every source is an installation of this plane's
  // one App, so it belongs on the row rather than behind a second request; null when the
  // plane has no GITHUB_APP_SLUG configured, and clients hide the link rather than guess.
  github_app_slug: z.string().nullable(),
  account_id: z.number().int().nullable(),
  repository_selection: RepositorySelectionSchema,
  permissions: z.record(z.string(), z.string()),
  events: z.array(z.string()),
  created_at: z.number(),
  updated_at: z.number(),
});

export type Source = z.infer<typeof SourceSchema>;

export const SourceListResponse = z.object({ sources: z.array(SourceSchema) });

// ADR-0009: destructive actions confirm at request time. The confirmation is the account
// login the operator can see on the card, not a boolean — a flag is something a client can
// set by accident, and this revokes cockpit's access to their repositories.
export const DisconnectSourceBody = z.object({
  confirm: z.string().min(1).openapi({
    description:
      "The connection's github_login, typed back to confirm the disconnect (case-insensitive)",
  }),
});

export const DisconnectSourceResponse = z.object({
  id: z.string(),
  revoked_on_github: z.boolean().openapi({
    description:
      "False when GitHub had no such installation for this App: already uninstalled, or " +
      "belonging to a different App than this plane is configured with. Removed either way",
  }),
});

// ADR-0012 — what an operator chooses from when importing a Project. Read straight from
// GitHub on request and never mirrored: the grant changes on github.com, not here.
export const RepositorySchema = z.object({
  id: ProjectSourceBinding.repository_id,
  full_name: ProjectSourceBinding.repository_full_name,
  default_branch: z.string().openapi({
    description: "Empty on a repository with no commits yet; there is nothing to deploy",
  }),
  private: z.boolean(),
  archived: z.boolean(),
});

export type Repository = z.infer<typeof RepositorySchema>;

// Paged, and explicitly so: a grant can be larger than one page, and answering with the
// first page alone would read as the whole grant.
export const RepositoryListResponse = z.object({
  repositories: z.array(RepositorySchema),
  page: z.number().int().positive(),
  per_page: z.number().int().positive(),
  total_count: z.number().int().nonnegative().openapi({
    description: "Repositories granted to the installation in total, not on this page",
  }),
  has_more: z.boolean().openapi({ description: "Ask for page + 1 to continue" }),
});

export const ConnectGitHubResponse = z.object({
  // Where the operator's browser goes to install the configured GitHub App.
  url: z.string(),
  state: z.string(), // echoed through GitHub's redirect; opaque
});

export const ResourceListResponse = z.object({ resources: z.array(ResourceSchema) });
export const ErrorResponse = z.object({ error: z.string() });
