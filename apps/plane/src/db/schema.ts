import { sql } from "drizzle-orm";
import type {
  Actor,
  ChangeSet,
  DeploymentStep,
  DeploymentTrigger,
  SourceRevision,
} from "../schema";
import {
  check,
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

type JsonObject = Record<string, unknown>;

// docs/type-design.md §2.1 / §2.1.1 — server and enrolment persistence stays unchanged.
export const servers = sqliteTable("servers", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  provider: text("provider").notNull(),
  addr: text("addr"),
  arch: text("arch"),
  status: text("status").notNull().default("enrolling"),
  agentVersion: text("agent_version"),
  // SHA-256 hex of the current per-server credential; null until the daemon first enrols.
  credentialHash: text("credential_hash"),
  lastSeenAt: integer("last_seen_at"),
  labels: text("labels").notNull().default("{}"),
  createdAt: integer("created_at").notNull(),
});

export const enrolments = sqliteTable("enrolments", {
  id: text("id").primaryKey(),
  serverId: text("server_id"), // null for claim_code until redeemed
  mode: text("mode").notNull(), // 'token' | 'claim_code'
  secretHash: text("secret_hash").notNull(), // SHA-256 hex; the secret itself is never stored
  presented: text("presented"), // JSON: { hostname, arch, addr, agent_version } | null
  expiresAt: integer("expires_at").notNull(),
  consumedAt: integer("consumed_at"),
  createdBy: text("created_by").notNull(), // JSON Actor
  createdAt: integer("created_at").notNull(),
});

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id),
    name: text("name").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_projects_server_name").on(table.serverId, table.name),
    uniqueIndex("idx_projects_id_server").on(table.id, table.serverId),
    index("idx_projects_server").on(table.serverId),
  ],
);

// One polymorphic table stores all resource kinds. The saved configuration is input for the
// next deployment or apply operation. The current release defines intended running state.
export const resources = sqliteTable(
  "resources",
  {
    id: text("id").primaryKey(),
    serverId: text("server_id").references(() => servers.id),
    projectId: text("project_id"),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    configuration: text("configuration", { mode: "json" }).$type<JsonObject>().notNull(),
    configurationVersion: integer("configuration_version").notNull(),
    currentReleaseId: text("current_release_id").references(
      (): AnySQLiteColumn => releases.id,
    ),
    health: text("health").notNull().default("unknown"),
    exposedAt: text("exposed_at"),
    drifted: integer("drifted", { mode: "boolean" }).notNull().default(false),
    observed: text("observed", { mode: "json" }).$type<JsonObject>(),
    observedRev: integer("observed_rev").notNull().default(0),
    observedAt: integer("observed_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    // SQLite treats null values as distinct. Coalescing gives account resources one identity.
    uniqueIndex("idx_resources_identity").on(
      sql`coalesce(${table.serverId}, '')`,
      table.kind,
      table.name,
    ),
    uniqueIndex("idx_resources_ownership").on(table.id, table.projectId, table.serverId),
    index("idx_resources_server").on(table.serverId),
    index("idx_resources_project").on(table.projectId),
    index("idx_resources_kind_health").on(table.kind, table.health),
    index("idx_resources_current_release").on(table.currentReleaseId),
    foreignKey({
      name: "resources_project_ownership",
      columns: [table.projectId, table.serverId],
      foreignColumns: [projects.id, projects.serverId],
    }),
    check(
      "resources_project_scope",
      sql`${table.projectId} IS NULL OR ${table.serverId} IS NOT NULL`,
    ),
    check(
      "resources_app_ownership",
      sql`${table.kind} <> 'app' OR (${table.serverId} IS NOT NULL AND ${table.projectId} IS NOT NULL)`,
    ),
  ],
);

export const deployments = sqliteTable(
  "deployments",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    appId: text("app_id").notNull(),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id),
    trigger: text("trigger", { mode: "json" }).$type<DeploymentTrigger>().notNull(),
    triggeredBy: text("triggered_by", { mode: "json" }).$type<Actor>().notNull(),
    status: text("status").notNull(),
    sourceRevision: text("source_revision", { mode: "json" }).$type<SourceRevision>(),
    configurationSnapshot: text("configuration_snapshot", { mode: "json" })
      .$type<JsonObject>()
      .notNull(),
    configurationVersion: integer("configuration_version").notNull(),
    steps: text("steps", { mode: "json" }).$type<DeploymentStep[]>().notNull(),
    changes: text("changes", { mode: "json" }).$type<ChangeSet>(),
    workflowId: text("workflow_id").notNull(),
    releaseId: text("release_id").references((): AnySQLiteColumn => releases.id),
    createdAt: integer("created_at").notNull(),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
  },
  (table) => [
    index("idx_deployments_project_created").on(table.projectId, table.createdAt),
    index("idx_deployments_app_created").on(table.appId, table.createdAt),
    index("idx_deployments_server_status").on(table.serverId, table.status),
    uniqueIndex("idx_deployments_workflow").on(table.workflowId),
    index("idx_deployments_release").on(table.releaseId),
    foreignKey({
      name: "deployments_project_ownership",
      columns: [table.projectId, table.serverId],
      foreignColumns: [projects.id, projects.serverId],
    }),
    foreignKey({
      name: "deployments_app_ownership",
      columns: [table.appId, table.projectId, table.serverId],
      foreignColumns: [resources.id, resources.projectId, resources.serverId],
    }),
  ],
);

export const operations = sqliteTable(
  "operations",
  {
    id: text("id").primaryKey(),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id),
    projectId: text("project_id").references(() => projects.id),
    resourceId: text("resource_id").references(() => resources.id),
    kind: text("kind").notNull(),
    actor: text("actor", { mode: "json" }).$type<Actor>().notNull(),
    status: text("status").notNull(),
    configurationSnapshot: text("configuration_snapshot", { mode: "json" }).$type<JsonObject>(),
    changes: text("changes", { mode: "json" }).$type<ChangeSet>(),
    workflowId: text("workflow_id"),
    releaseId: text("release_id").references((): AnySQLiteColumn => releases.id),
    createdAt: integer("created_at").notNull(),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
  },
  (table) => [
    index("idx_operations_server_status").on(table.serverId, table.status),
    index("idx_operations_project_created").on(table.projectId, table.createdAt),
    index("idx_operations_resource_created").on(table.resourceId, table.createdAt),
    uniqueIndex("idx_operations_workflow").on(table.workflowId),
    index("idx_operations_release").on(table.releaseId),
  ],
);

export const releases = sqliteTable(
  "releases",
  {
    id: text("id").primaryKey(),
    resourceId: text("resource_id")
      .notNull()
      .references((): AnySQLiteColumn => resources.id),
    rev: integer("rev").notNull(),
    deploymentId: text("deployment_id").references((): AnySQLiteColumn => deployments.id),
    operationId: text("operation_id").references((): AnySQLiteColumn => operations.id),
    configurationSnapshot: text("configuration_snapshot", { mode: "json" })
      .$type<JsonObject>()
      .notNull(),
    runtimeSnapshot: text("runtime_snapshot", { mode: "json" }).$type<JsonObject>().notNull(),
    sourceRevision: text("source_revision", { mode: "json" }).$type<SourceRevision>(),
    imageDigest: text("image_digest"),
    restoredFromReleaseId: text("restored_from_release_id").references(
      (): AnySQLiteColumn => releases.id,
    ),
    status: text("status").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_releases_resource_rev").on(table.resourceId, table.rev),
    index("idx_releases_resource_status").on(table.resourceId, table.status),
    uniqueIndex("idx_releases_one_active")
      .on(table.resourceId)
      .where(sql`${table.status} = 'active'`),
    index("idx_releases_deployment").on(table.deploymentId),
    index("idx_releases_operation").on(table.operationId),
    check("releases_status", sql`${table.status} IN ('active', 'superseded')`),
    check(
      "releases_one_origin",
      sql`(${table.deploymentId} IS NOT NULL AND ${table.operationId} IS NULL) OR (${table.deploymentId} IS NULL AND ${table.operationId} IS NOT NULL)`,
    ),
  ],
);

// ADR-0010 — one row per GitHub App installation, mirrored from GitHub's record and
// updated in place on re-delivery (unique on provider + installation_id). Account-scoped
// (ADR-0007): no server_id column at all. Deliberately no token column: installation
// access tokens are short-lived and minted on demand, never persisted.
export const sources = sqliteTable(
  "sources",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull().default("github"),
    name: text("name").notNull(), // display name; defaults to the login at connect time
    login: text("login").notNull(), // GitHub account/org login the app is installed on
    installationId: integer("installation_id").notNull(),
    accountId: integer("account_id"), // GitHub's numeric account id; nullable if GitHub omits it
    repositorySelection: text("repository_selection").notNull().default("all"),
    permissions: text("permissions", { mode: "json" })
      .$type<Record<string, string>>()
      .notNull(),
    events: text("events", { mode: "json" }).$type<string[]>().notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_sources_provider_installation").on(table.provider, table.installationId),
    index("idx_sources_name").on(table.name),
    check("sources_provider", sql`${table.provider} IN ('github')`),
    check(
      "sources_repository_selection",
      sql`${table.repositorySelection} IN ('all', 'selected')`,
    ),
  ],
);

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    serverId: text("server_id").references(() => servers.id),
    projectId: text("project_id").references(() => projects.id),
    resourceId: text("resource_id").references(() => resources.id),
    deploymentId: text("deployment_id").references(() => deployments.id),
    operationId: text("operation_id").references(() => operations.id),
    type: text("type").notNull(),
    actor: text("actor", { mode: "json" }).$type<Actor>().notNull(),
    payload: text("payload", { mode: "json" }).$type<JsonObject>().notNull(),
    at: integer("at").notNull(),
  },
  (table) => [
    index("idx_events_at").on(table.at),
    index("idx_events_server_at").on(table.serverId, table.at),
    index("idx_events_project_at").on(table.projectId, table.at),
    index("idx_events_resource_at").on(table.resourceId, table.at),
    index("idx_events_deployment_at").on(table.deploymentId, table.at),
    index("idx_events_operation_at").on(table.operationId, table.at),
  ],
);
