CREATE TABLE servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  addr TEXT,
  arch TEXT,
  status TEXT NOT NULL DEFAULT 'enrolling',
  agent_version TEXT,
  credential_hash TEXT,
  last_seen_at INTEGER,
  labels TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE enrolments (
  id TEXT PRIMARY KEY,
  server_id TEXT REFERENCES servers(id),
  mode TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  presented TEXT,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_enrolments_secret_hash ON enrolments(secret_hash);
CREATE INDEX idx_servers_credential_hash ON servers(credential_hash);
