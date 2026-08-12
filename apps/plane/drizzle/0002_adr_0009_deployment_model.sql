-- Replace the Plan prototype with the deployment model from ADR-0009.
-- Existing resource rows stay in place. Their saved spec becomes configuration version 1,
-- and no migration result claims that a release already exists.

DROP TABLE plans;
ALTER TABLE resources RENAME TO resources_legacy;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id),
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_projects_server_name ON projects(server_id, name);
CREATE UNIQUE INDEX idx_projects_id_server ON projects(id, server_id);
CREATE INDEX idx_projects_server ON projects(server_id);

-- A legacy project id was not owned by a project row, so different servers could reuse it.
-- Hex encoding makes each `(server, legacy project)` id deterministic and free of delimiter
-- ambiguity. The namespace tag keeps these ids distinct from generated default projects.
INSERT INTO projects (id, server_id, name, created_at, updated_at)
SELECT
  'prj_migrated_legacy_' || lower(hex(server_id)) || '_' || lower(hex(project_id)),
  server_id,
  'migration-project-' || lower(hex(project_id)),
  MIN(created_at),
  MAX(updated_at)
FROM resources_legacy
WHERE project_id IS NOT NULL AND server_id IS NOT NULL
GROUP BY server_id, project_id;

-- ADR-0009 requires each app to belong to one project. Group unowned legacy apps into one
-- deterministic migration project for their server.
INSERT INTO projects (id, server_id, name, created_at, updated_at)
SELECT
  'prj_migrated_default_' || lower(hex(server_id)),
  server_id,
  'migration-default-apps',
  MIN(created_at),
  MAX(updated_at)
FROM resources_legacy
WHERE kind = 'app' AND project_id IS NULL AND server_id IS NOT NULL
GROUP BY server_id;

CREATE TABLE resources (
  id TEXT PRIMARY KEY,
  server_id TEXT REFERENCES servers(id),
  project_id TEXT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  configuration TEXT NOT NULL,
  configuration_version INTEGER NOT NULL,
  current_release_id TEXT REFERENCES releases(id),
  health TEXT NOT NULL DEFAULT 'unknown',
  exposed_at TEXT,
  drifted INTEGER NOT NULL DEFAULT 0,
  observed TEXT,
  observed_rev INTEGER NOT NULL DEFAULT 0,
  observed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CONSTRAINT resources_project_ownership
    FOREIGN KEY (project_id, server_id) REFERENCES projects(id, server_id),
  CONSTRAINT resources_project_scope CHECK (project_id IS NULL OR server_id IS NOT NULL),
  CONSTRAINT resources_app_ownership
    CHECK (kind <> 'app' OR (server_id IS NOT NULL AND project_id IS NOT NULL))
);

-- SQLite requires the exact parent key to exist before any statement can use a child table.
CREATE UNIQUE INDEX idx_resources_ownership ON resources(id, project_id, server_id);

CREATE TABLE deployments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  server_id TEXT NOT NULL REFERENCES servers(id),
  trigger TEXT NOT NULL,
  triggered_by TEXT NOT NULL,
  status TEXT NOT NULL,
  source_revision TEXT,
  configuration_snapshot TEXT NOT NULL,
  configuration_version INTEGER NOT NULL,
  steps TEXT NOT NULL,
  changes TEXT,
  workflow_id TEXT NOT NULL,
  release_id TEXT REFERENCES releases(id),
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  CONSTRAINT deployments_project_ownership
    FOREIGN KEY (project_id, server_id) REFERENCES projects(id, server_id),
  CONSTRAINT deployments_app_ownership
    FOREIGN KEY (app_id, project_id, server_id)
    REFERENCES resources(id, project_id, server_id)
);

CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id),
  project_id TEXT REFERENCES projects(id),
  resource_id TEXT REFERENCES resources(id),
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  status TEXT NOT NULL,
  configuration_snapshot TEXT,
  changes TEXT,
  workflow_id TEXT,
  release_id TEXT REFERENCES releases(id),
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);

CREATE TABLE releases (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resources(id),
  rev INTEGER NOT NULL,
  deployment_id TEXT REFERENCES deployments(id),
  operation_id TEXT REFERENCES operations(id),
  configuration_snapshot TEXT NOT NULL,
  runtime_snapshot TEXT NOT NULL,
  source_revision TEXT,
  image_digest TEXT,
  restored_from_release_id TEXT REFERENCES releases(id),
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CONSTRAINT releases_status CHECK (status IN ('active', 'superseded')),
  CONSTRAINT releases_one_origin CHECK (
    (deployment_id IS NOT NULL AND operation_id IS NULL)
    OR (deployment_id IS NULL AND operation_id IS NOT NULL)
  )
);

INSERT INTO resources (
  id,
  server_id,
  project_id,
  kind,
  name,
  configuration,
  configuration_version,
  current_release_id,
  health,
  exposed_at,
  drifted,
  observed,
  observed_rev,
  observed_at,
  created_at,
  updated_at
)
SELECT
  id,
  server_id,
  CASE
    WHEN kind = 'app' AND project_id IS NULL
      THEN 'prj_migrated_default_' || lower(hex(server_id))
    WHEN project_id IS NOT NULL AND server_id IS NOT NULL
      THEN 'prj_migrated_legacy_' || lower(hex(server_id)) || '_' || lower(hex(project_id))
    ELSE NULL
  END,
  kind,
  name,
  spec,
  1,
  NULL,
  'unknown',
  NULL,
  0,
  NULL,
  0,
  NULL,
  created_at,
  updated_at
FROM resources_legacy;

DROP TABLE resources_legacy;

-- COALESCE gives each account-scoped resource one `(kind, name)` identity. SQLite otherwise
-- treats null server ids as distinct and permits duplicate account resources.
CREATE UNIQUE INDEX idx_resources_identity
  ON resources(COALESCE(server_id, ''), kind, name);
CREATE INDEX idx_resources_server ON resources(server_id);
CREATE INDEX idx_resources_project ON resources(project_id);
CREATE INDEX idx_resources_kind_health ON resources(kind, health);
CREATE INDEX idx_resources_current_release ON resources(current_release_id);

CREATE INDEX idx_deployments_project_created ON deployments(project_id, created_at);
CREATE INDEX idx_deployments_app_created ON deployments(app_id, created_at);
CREATE INDEX idx_deployments_server_status ON deployments(server_id, status);
CREATE UNIQUE INDEX idx_deployments_workflow ON deployments(workflow_id);
CREATE INDEX idx_deployments_release ON deployments(release_id);

CREATE INDEX idx_operations_server_status ON operations(server_id, status);
CREATE INDEX idx_operations_project_created ON operations(project_id, created_at);
CREATE INDEX idx_operations_resource_created ON operations(resource_id, created_at);
CREATE UNIQUE INDEX idx_operations_workflow ON operations(workflow_id);
CREATE INDEX idx_operations_release ON operations(release_id);

CREATE UNIQUE INDEX idx_releases_resource_rev ON releases(resource_id, rev);
CREATE INDEX idx_releases_resource_status ON releases(resource_id, status);
CREATE UNIQUE INDEX idx_releases_one_active ON releases(resource_id) WHERE status = 'active';
CREATE INDEX idx_releases_deployment ON releases(deployment_id);
CREATE INDEX idx_releases_operation ON releases(operation_id);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  server_id TEXT REFERENCES servers(id),
  project_id TEXT REFERENCES projects(id),
  resource_id TEXT REFERENCES resources(id),
  deployment_id TEXT REFERENCES deployments(id),
  operation_id TEXT REFERENCES operations(id),
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload TEXT NOT NULL,
  at INTEGER NOT NULL
);

CREATE INDEX idx_events_at ON events(at);
CREATE INDEX idx_events_server_at ON events(server_id, at);
CREATE INDEX idx_events_project_at ON events(project_id, at);
CREATE INDEX idx_events_resource_at ON events(resource_id, at);
CREATE INDEX idx_events_deployment_at ON events(deployment_id, at);
CREATE INDEX idx_events_operation_at ON events(operation_id, at);
