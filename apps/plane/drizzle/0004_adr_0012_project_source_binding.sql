-- ADR-0012: a Project is one GitHub-backed Compose stack on one server. The source binding
-- and the Plane-owned deployment settings live on the project row.
--
-- Additive on purpose. Projects created before this migration (and by POST /projects) have
-- no source binding, so every binding column is nullable and existing rows keep working.
-- New imports come through POST /projects/import, which requires the whole binding — the
-- "all or nothing" rule is enforced at the API boundary because SQLite cannot add a
-- table-level CHECK to an existing table without rewriting it.

ALTER TABLE projects ADD COLUMN source_id TEXT REFERENCES sources(id);
ALTER TABLE projects ADD COLUMN repository_id TEXT;
ALTER TABLE projects ADD COLUMN repository_full_name TEXT;
ALTER TABLE projects ADD COLUMN ref TEXT;
-- Base directory of the stack inside the repository; compose_path is relative to it.
ALTER TABLE projects ADD COLUMN base_directory TEXT;
ALTER TABLE projects ADD COLUMN compose_path TEXT;
ALTER TABLE projects ADD COLUMN auto_deploy INTEGER NOT NULL DEFAULT 0 CHECK (auto_deploy IN (0, 1));
-- Only target-specific bindings (§2.4). Compose service definitions are never copied here.
ALTER TABLE projects ADD COLUMN settings TEXT NOT NULL
  DEFAULT '{"ingress":null,"migration":null,"health":{"required_services":[]},"variables":{}}';

CREATE INDEX idx_projects_source ON projects(source_id);
-- One repository can back several Projects through different base directories, Compose
-- paths, or refs, but importing the same stack twice onto the same server is a mistake.
-- `ref` is part of the key: the same directory and file on `main` and on `staging` are two
-- deployable stacks, and leaving it out would refuse the second as a duplicate. Legacy rows
-- hold NULLs, which SQLite treats as distinct, so they never collide here.
CREATE UNIQUE INDEX idx_projects_stack
  ON projects(server_id, source_id, repository_id, ref, base_directory, compose_path);
