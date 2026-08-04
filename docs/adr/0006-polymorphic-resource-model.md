# One polymorphic Resource entity, with Links as first-class relationships

Status: accepted

Everything cockpit manages on a server is a `Resource`: `{ server, kind, name, spec }`,
where `spec` is JSON validated against that kind's Zod schema. Relationships between
resources are stored explicitly as `Link` rows.

## Why

**Type-per-thing is what makes platforms rigid.** Coolify has a distinct table, API
shape, and UI page per resource type. Every new capability is a change in five places, so
capabilities arrive slowly and inconsistently. Under a polymorphic model, adding
PostgreSQL 17, or MinIO, or a queue worker is a spec schema plus a daemon handler — the
API, the plan engine, the release history, the audit log, the CLI, the MCP tools, and the
generic UI views all work already.

**The plan engine wants uniformity.** Diffing "spec vs observed" is a single mechanism if
resources are uniform, and N mechanisms if they are not. The same is true of releases,
drift detection, and rollback. The polymorphic model is what keeps ADR-0003's promises
cheap.

**Links are the thing that was actually missing.** Neither `yoke` nor the `/devops`
playbooks modelled that `jerry` uses `db-jerry` and is exposed at `jerry.oflabs.dev` —
that knowledge lived in the operator's head, or was reconstructed by inspection. Storing
it enables, all at once: dependency-ordered deploys, blast-radius answers before a
destructive plan, the fleet graph as the UI's spine, automatic env injection from a
database's connection details, and an agent that can answer "why is jerry down" from one
call instead of fifteen.

**Coolify half-has links and it shows.** Relationships are implied by which form the user
was on, so the UI cannot explain how things connect and the operator must remember. Making
relationships explicit data is a large part of the UX gap this project exists to close.

## Consequences

- **`spec` is JSON in SQL**, so relational constraints cannot police its contents. Zod at
  the API boundary is the only validator, and every write path must go through it. Fields
  needed for querying or indexing (health, current release, exposure) are promoted to real
  columns rather than dug out of JSON.
- **Spec schemas need versioning.** A kind's schema will change; stored specs and stored
  release snapshots must remain readable. Each spec carries a schema version and a
  migration path forward.
- **Generic UI needs kind-specific affordances.** The generic list, detail, plan, and
  history views come free, but a database needs a backup panel and an app needs a deploy
  button. The pattern is a generic shell with per-kind panels registered by kind — not a
  bespoke page per kind.
- **Links must be maintained on delete.** Removing a resource with inbound links is a
  `destructive` plan that must surface what depends on it. Dangling links are a bug class
  to test for explicitly.
- **Link kinds are a closed set** (`uses`, `exposed_at`, `depends_on`, `backs_up`,
  `routes_to`). An open-ended relationship vocabulary would make the graph unqueryable.
