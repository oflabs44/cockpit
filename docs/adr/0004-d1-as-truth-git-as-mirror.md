# D1 is the truth; git is an export mirror

Status: accepted

Configuration, deployments, operations, and releases live in D1. Each successful
configuration apply can commit a snapshot to a git repository the operator controls.
Nothing in Cockpit ever reads from git.

The rejected alternative was git-as-truth with a reconciler — a repo of resource specs,
converged onto servers, in the manner of Flux or Terraform.

## Why

**Deployment records provide the useful git properties.** Git-as-truth is attractive
because it yields reviewable diffs, `git log` as an audit trail, and revert as rollback.
Cockpit records changes and immutable release snapshots directly (ADR-0009), without
making a git repository the read path of a dashboard.

**A UI over a git repo is a bad UI.** Every list view becomes a clone-parse-walk.
Cross-cutting queries — "every app on prod using db-jerry", "everything unhealthy",
"everything deployed this week" — are trivial in SQL and painful over a tree of files.
cockpit is a dense, query-heavy interface (its whole reason for existing over Coolify is
UX), and the storage engine must serve that.

**Many moving parts is exactly where git-as-truth strains.** A fleet with servers, apps,
databases, volumes, networks, cron jobs, firewall rules, and DNS records — plus links
between them — is a graph. Files model trees. Referential integrity across files is
hand-rolled; in SQL it is a constraint.

**The mirror is nearly free and keeps the good parts.** Writing a snapshot on apply costs
one commit and buys: `git log -p` over the whole fleet's history, review in the
operator's existing terminal diff viewer, an off-platform copy of all configuration, and
a rebuild path if the plane's data is ever lost. Because it is write-only, it can never
be on the critical path or a source of consistency bugs.

## Consequences

- **The mirror can drift or fail, and must not matter.** Snapshot commits are best-effort
  and asynchronous. A failed push produces an event and an alert, never a failed apply.
- **Git is not an input.** Editing the mirror repo does nothing. This must be documented
  in the repo itself (a generated header in every snapshot file) or it will eventually be
  edited by someone expecting GitOps semantics.
- **Secrets never reach the mirror.** Only secret refs are stored anywhere (CONTEXT #15),
  so this follows automatically — but snapshot serialisation must be tested for it, since
  the mirror is the most likely place for a leak to become permanent and public.
- **D1 needs its own backup discipline** independent of the mirror, since the mirror holds
  configuration but not deployments, operations, releases, events, or links.
- **A future GitOps mode stays possible.** Nothing here forecloses accepting the repo as
  an input later; it would be an additional deployment trigger, not a storage change.
