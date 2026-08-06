import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// docs/type-design.md §2.1 / §2.1.1 / §2.2 / §2.5 — servers, enrolments, resources, plans.
// `labels`, `presented`, and `created_by` are JSON-in-text: Zod at the API boundary is the
// validator, relational constraints cannot police JSON (type-design §2.2).

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

// One polymorphic table for every kind (ADR-0006). `spec` is JSON: the kind registry's Zod
// schema at the API boundary is the only validator.
export const resources = sqliteTable("resources", {
  id: text("id").primaryKey(),
  serverId: text("server_id"), // null for account-scoped kinds (#11); none registered yet
  projectId: text("project_id"),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  spec: text("spec").notNull(), // JSON Spec
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const plans = sqliteTable("plans", {
  id: text("id").primaryKey(),
  serverId: text("server_id").notNull(),
  resourceId: text("resource_id").notNull(),
  status: text("status").notNull(),
  changes: text("changes").notNull(), // JSON Change[]
  basis: text("basis").notNull(), // JSON { observed_rev, observed_at } — #7
  actor: text("actor").notNull(), // JSON { created_by, decided_by }
  createdAt: integer("created_at").notNull(),
  decidedAt: integer("decided_at"),
  approvedAt: integer("approved_at"),
});
