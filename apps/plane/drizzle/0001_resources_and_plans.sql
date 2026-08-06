-- docs/type-design.md §2.2 / §2.5 — the desired-state half of the model.
-- One polymorphic `resources` table for every kind (ADR-0006, #10): adding a kind is a spec
-- schema plus a daemon handler, never a table.

CREATE TABLE resources (
  id TEXT PRIMARY KEY,
  -- Null for account-scoped kinds (#11, ADR-0007). No such kind is registered yet.
  server_id TEXT REFERENCES servers(id),
  -- Grouping metadata only; there is no projects table in this slice (type-design §4).
  project_id TEXT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  spec TEXT NOT NULL, -- JSON; Zod at the API boundary is the only validator (ADR-0006)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- COALESCE, not a bare `server_id`: NULLs are distinct from each other in SQLite, so a plain
-- unique index would admit unlimited duplicates of any account-scoped kind (#11) — exactly the
-- rows whose identity is `(kind, name)` alone.
CREATE UNIQUE INDEX idx_resources_identity
  ON resources(COALESCE(server_id, ''), kind, name);

CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id),
  resource_id TEXT NOT NULL REFERENCES resources(id),
  -- pending | approved | rejected | applying | applied | failed | reverted (type-design §2.5).
  status TEXT NOT NULL,
  changes TEXT NOT NULL, -- JSON Change[]
  -- JSON { observed_rev, observed_at }: the snapshot this diff was computed against (#7).
  basis TEXT NOT NULL,
  actor TEXT NOT NULL, -- JSON { created_by: Actor, decided_by: Actor | null }
  created_at INTEGER NOT NULL,
  -- When the plan was decided, either way; `approved_at` is set only when that decision was
  -- an approval, so a rejection is fully attributed (who + when) rather than half.
  decided_at INTEGER,
  approved_at INTEGER
);

CREATE INDEX idx_plans_status ON plans(status);
CREATE INDEX idx_plans_server ON plans(server_id);
