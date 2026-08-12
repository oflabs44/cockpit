# One polymorphic Resource entity, with Links as first-class relationships

Status: accepted

Everything Cockpit manages is a `Resource`: `{ server, kind, name, configuration }`.
Configuration is JSON validated against that kind's Zod schema. Relationships between
resources are stored explicitly as `Link` rows.

## Why

**Type-per-thing is what makes platforms rigid.** Coolify has a distinct table, API
shape, and UI page per resource type. Every new capability is a change in five places, so
capabilities arrive slowly and inconsistently. Under a polymorphic model, adding
PostgreSQL 17, MinIO, or a queue worker is a configuration schema plus a daemon handler.
The API, operation path, release history, audit log, MCP tools, and generic UI views all
work already.

**Change calculation wants uniformity.** Diffing a release candidate against observed
state is one mechanism if resources are uniform, and many mechanisms if they are not. The
same is true of releases and drift detection.

**Links are the thing that was actually missing.** Neither `yoke` nor the `/devops`
playbooks modelled that `jerry` uses `db-jerry` and is exposed at `jerry.oflabs.dev` —
that knowledge lived in the operator's head, or was reconstructed by inspection. Storing
it enables, all at once: dependency-ordered deploys, blast-radius answers before a
destructive operation, the fleet graph as the UI's spine, automatic env injection from a
database's connection details, and an agent that can answer "why is jerry down" from one
call instead of fifteen.

**Coolify half-has links and it shows.** Relationships are implied by which form the user
was on, so the UI cannot explain how things connect and the operator must remember. Making
relationships explicit data is a large part of the UX gap this project exists to close.

## Consequences

- **`configuration` is JSON in SQL**, so relational constraints cannot police its
  contents. Zod at the API boundary is the validator, and every write path goes through
  it. Fields needed for queries or indexes become real columns.
- **Configuration schemas need versioning.** A kind's schema will change. Saved
  configuration and release snapshots must remain readable. Each configuration carries a
  schema version and migration path.
- **Generic UI needs kind-specific affordances.** The generic list, detail, operation,
  and history views come free, but a database needs a backup panel and an app needs a deploy
  button. The pattern is a generic shell with per-kind panels registered by kind — not a
  bespoke page per kind.
- **Links must be maintained on delete.** Removing a resource with inbound links is a
  destructive operation that must show what depends on it. Dangling links are a bug class
  to test for explicitly.
- **Link kinds are a closed set** (`uses`, `exposed_at`, `depends_on`, `backs_up`,
  `routes_to`). An open-ended relationship vocabulary would make the graph unqueryable.
