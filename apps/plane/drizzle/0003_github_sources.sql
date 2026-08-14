-- ADR-0010: GitHub App installations get their own `sources` table. An installation is
-- GitHub's record mirrored here for navigation — not daemon-applied configuration, so it
-- does not live in `resources`. Account-scoped (ADR-0007): no server_id. No tokens are
-- stored: installation access tokens are minted on demand from the app private key
-- (a Worker secret) and are never persisted.

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'github' CHECK (provider IN ('github')),
  name TEXT NOT NULL,
  login TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  account_id INTEGER,
  repository_selection TEXT NOT NULL DEFAULT 'all' CHECK (repository_selection IN ('all', 'selected')),
  permissions TEXT NOT NULL DEFAULT '{}',
  events TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- GitHub redelivers installation callbacks (install, then permission updates) keyed by
-- installation id — one row per installation, updated in place.
CREATE UNIQUE INDEX idx_sources_provider_installation ON sources(provider, installation_id);
CREATE INDEX idx_sources_name ON sources(name);
