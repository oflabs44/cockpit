# Every kind declares its scope: server or account

Status: accepted (amended — projects added inside a server)

`Resource` stays one polymorphic table (ADR-0006), but each `kind` now declares a
**scope**. Server-scoped kinds have a `server_id`; account-scoped kinds do not, and
`server_id` is nullable.

- **Server-scoped** — `app`, `database`, `volume`, `network`, `cron`, `daemon`,
  `firewall_rule`, `proxy`. Things that physically exist on a box.
- **Account-scoped** — `domain`, `dns_record`, `source`, `secret`, `backup_destination`.
  Things that have no box.

An app belongs to exactly one server and cannot span servers.

**Projects group resources inside a server.** A project is a named grouping of the
resources on one box — an app plus the database, volume, and cron that serve it. It is a
label on resources, not a level above them, and a resource may belong to at most one
project. Resources on a server that belong to no project are shared with the whole server.

## Why

**Containment is honest for anything the daemon can see.** Apps, databases, volumes,
networks, cron entries, and firewall rules are Docker, systemd, and UFW objects. They
cannot outlive the machine, cannot move without being recreated, and the daemon reports
them per-host. Modelling them as anything other than contained would invent a fiction
nothing can back up.

**Four things break containment, and forcing them into it inverts the relationship.**
A domain is the clearest case: `jerry.oflabs.dev` lives in a DNS zone. It exists before
the server, survives the server being destroyed, and is precisely the thing you change
when moving an app between boxes. Saying the domain is *on* prod-fsn1 has it backwards —
the domain *points at* an app that is. The same holds for a GitHub connection, a vault
namespace, and a backup bucket, all of which are per-account by construction and useless
if they die with a host.

**A scope field costs nothing and needs no new concept.** One table, one plan engine, one
release history, one audit log, one generic UI — all unchanged. `Link` already spans the
boundary (`domain --routes_to--> app`), so the relationship is data rather than a special
case.

**One app, one server keeps the daemon protocol simple.** A task targets a server; a
resource's identity is `(server, kind, name)`; an apply is a conversation with exactly one
daemon. Multi-server apps would require placement, cross-host networking, and a scheduler
— which is the point at which this stops being a personal platform and becomes Nomad.
Scaling here means a bigger box or more replicas on the same box.

**No project level *above* the server.** Coolify and Railway have Projects because an app
can deploy across servers and destinations, so they need a grouping that is not the
server — Railway has no server at all, which is why Project is its isolation boundary.
Here the box already is one.

**But a project *inside* a server earns its place.** Once a server holds a dozen
resources, a flat list stops answering the question you actually arrive with: which of
these belong together? A project answers it, and it is cheap — a nullable `project_id` on
`Resource`, no new scope, no new isolation boundary, no change to the daemon protocol. It
groups; it does not contain.

The distinction matters because the two are easy to confuse and only one is safe. A
project above the server would need placement, cross-host networking, and a scheduler. A
project inside one needs a column.

## Consequences

- `server_id` is nullable, so every query and every UI list must be explicit about which
  scope it is showing. A resource list that silently mixes both would be confusing in
  exactly the way this decision is meant to prevent.
- Account-scoped kinds get their own rail section, not a home under Settings. Domains are
  operational — touched on most deploys — and burying routing in configuration would
  misrepresent how often it is used.
- Deleting a server must not orphan account-scoped resources that pointed at it. A domain
  whose target is destroyed becomes unrouted, which is a visible state, not a dangling
  link.
- Moving an app between servers is delete-and-recreate, plus repointing its domain. That
  is honest — the container genuinely is a new object — and the domain surviving is what
  makes it tolerable.
- If a real multi-server case ever appears, this is the decision to revisit first. The
  seam is deliberately *not* preserved: identity is `(server, kind, name)`, and changing
  that later is a migration, accepted knowingly rather than hedged against.
