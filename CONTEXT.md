# cockpit — Domain Glossary

> Name: **cockpit** — the place you sit to fly the thing. A personal cloud
> deployment platform for private VPSes you own: provision, deploy, observe,
> operate. Packages are scoped `@oflabs44/cockpit-*`. The on-box agent binary is
> `cockpitd`. The laptop binary is `cockpit`.

Canonical definitions for this project. When a term here conflicts with how
something is described elsewhere, this file wins. Keep it about *what terms
mean*, not *how things are implemented* — implementation lives in
[`docs/type-design.md`](./docs/type-design.md), rationale in [`docs/adr/`](./docs/adr/).

---

## What cockpit is

A control plane for VPSes you personally own. It replaces Coolify in the
operator's stack, and absorbs the role previously played by the `yoke` CLI plus
the `/devops` skill's playbooks.

Three things existed before cockpit and explain its shape:

- **`yoke`** — a stateless Go CLI exposing composable verbs over Docker, UFW,
  cron, and systemd via SSH. It deliberately held no state, ran no daemon, and
  exposed no MCP server. Its command knowledge (the exact `docker run` flags,
  UFW/cloud-firewall mediation, healthcheck polling, typed errors) is the real
  asset and is **ported into `cockpitd`** — transport-independent knowledge,
  new transport.
- **The `/devops` playbooks** — ~17 markdown procedures an AI agent read and
  followed. They worked, but they are *a program written in English*: three
  agents running the same playbook produce three different results. cockpit
  compiles them into typed, testable operations.
- **Coolify** — used read-only to answer "what is actually deployed." It was
  needed because yoke deliberately remembered nothing. cockpit closes that hole
  and Coolify is removed.

cockpit is the **state, intent, and memory** layer. `cockpitd` is the hands.

---

## Locked decisions

Numbered so other docs can reference them as `(#n)`.

1. **One API. Two clients. Zero capability gap.**
   Every capability is a typed operation on the plane's API. The web UI and the
   MCP server are both *clients*, and neither may do anything the other cannot.
   A CLI is deliberately deferred, not rejected — it would be a third client of
   the same API and must not require a single new endpoint. See ADR-0005.

2. **No business logic above the API.**
   The corollary of #1, and the enforceable version of it. If a client
   computes, validates, orders, or decides anything, that is a bug — it means
   another client cannot do it correctly. Clients render and dispatch. This is
   the single rule that keeps "AI-first" true rather than aspirational.

3. **AI-first means peer access, not a chat box.**
   An agent driving cockpit over MCP and a human driving it in the UI are peers
   on the same control plane. Every agent action appears in the UI as a
   first-class `Event` and `Plan`, attributable to the agent that made it.
   cockpit ships no conversational surface of its own.

4. **The daemon is the only execution path. cockpit never uses SSH.**
   `cockpitd` runs on every managed server and dials **out** to the plane over
   WSS. The plane holds no SSH keys, opens no connections, and needs no inbound
   port on any box. Onboarding is a one-line install script the operator runs on
   the box themselves — it hardens the host, installs Docker and the daemon, and
   enrols either with a pre-authorised token or by printing a claim code the
   operator redeems in any client. SSH remains the operator's own out-of-band
   access to their box; it is not a component of cockpit. See ADR-0001.

5. **The control plane is serverless and lives nowhere near the servers it
   controls.** Cloudflare Workers + D1 + Durable Objects + Workflows + Queues +
   R2. It survives any managed box dying, which is precisely when it is needed.
   Hosting the control plane on the thing being controlled — Coolify's model —
   is rejected. See ADR-0002.

6. **The `Plan` is the unit of change to desired state.**
   Changing what a resource *is* — its spec — produces a `Plan`: a typed list
   of changes, each with `before`, `after`, a declared `inverse`, and an
   `impact`, approved then applied. Operations that leave the spec identical —
   restart, stop, exec, logs, terminal — are direct, and recorded as `Event`s
   with an actor. The test is whether the spec afterwards says something
   different. Nothing mutates unattributably; not everything is a plan.
   See ADR-0003.

7. **Plans are computed against observed state, never last-known state.**
   The daemon reports what is actually on the box; the planner diffs desired
   against observed. Drift detection is therefore not a feature — a plan
   containing changes nobody requested *is* drift.

8. **Every change declares an inverse, or declares itself irreversible.**
   Rollback is mechanical, derived from `Plan.changes[].inverse`. No
   hand-written rollback logic exists anywhere in the system.

9. **D1 is the truth. Git is a mirror.**
   The reviewable-diff property comes from the `Plan` object, not from git being
   the storage engine. Each applied plan may commit a config snapshot to a repo
   for audit, `git log -p`, and disaster recovery — but nothing in cockpit ever
   *reads* from git. See ADR-0004.

10. **One polymorphic `Resource` table, not a table per kind.**
    A resource is `{ kind, name, server_id, spec }`. Adding support for a new
    kind is a new spec schema plus a new daemon handler — never a new table, new
    API surface, or new UI page. Coolify's type-per-thing model is what makes it
    rigid. See ADR-0006.

11. **Every kind declares a scope: server or account.**
    Anything the daemon can see is contained by its server — `app`, `database`,
    `volume`, `network`, `cron`, `daemon`, `firewall_rule`, `proxy`. Things with
    no box are account-scoped and `server_id` is null — `domain`, `dns_record`,
    `source`, `secret`, `backup_destination`. A domain does not live *on* a
    server; it *points at* an app that does. An app belongs to exactly one
    server and cannot span servers, and there is no project or grouping level
    above the server. See ADR-0007.

12. **`Link` is a first-class entity.**
    Relationships between resources (`uses`, `exposed_at`, `backs_up`,
    `depends_on`) are stored, not implied by which form the operator was on.
    This is what enables dependency-ordered deploys, blast-radius answers, the
    fleet graph, and an agent that can diagnose an outage in one call.

13. **The daemon is stateless.**
    The box is the truth — yoke's principle, preserved. `cockpitd` holds no
    database and no desired state. It observes, reports, and executes
    idempotent ops. A task re-sent after a reconnect is safe to re-run.

14. **All operations are ensure-semantics and idempotent**, returning
    `create | in_place | replace | no_op`. Inherited directly from yoke. No
    "skip if exists" wrappers anywhere.

15. **Secrets are references, never values — resolved on the box.**
    Env values are stored as provider-scheme refs (`op://…`, and later
    `aws://…`, `vault://…`) and resolved by the **daemon**, immediately before
    use, never persisted. Not by the plane: handing the control plane plaintext
    would restore exactly the blast radius that holding no SSH keys removes.
    Not by the browser: that would make every apply need a human, killing
    agent-initiated and scheduled deploys. cockpit can never display a secret's
    value because it never has one. Inherited from the `/devops` skill's Rule
    #2, now enforced by types. See ADR-0008.

16. **`impact` is data, not documentation.**
    Each change carries `none | reload | restart | replace | destructive`. The
    UI renders by it, the approval gate branches on it, and the MCP server
    surfaces it. This is the `/devops` skill's action card (its Rule #3),
    promoted from a prose instruction an agent might forget into a field the
    system cannot skip.

17. **Builds run on the target server, for now.**
    v1 clones and builds on the box the app will run on — no registry
    round-trip, image never leaves the host. Accepted cost: builds consume
    production CPU, RAM, and disk. Therefore build resource limits and a layer
    prune policy are part of the model from day one, not retrofitted. Moving
    builds to a dedicated builder or back to laptop-buildx-plus-registry is a
    later optimisation, not a prerequisite.

18. **Traefik stays the proxy, driven by Docker labels.**
    The daemon sets container labels; Traefik reconfigures itself. cockpit owns
    no proxy configuration file and therefore has no proxy config state to
    manage or drift from.

19. **Single-tenant now, clean seams for later.**
    No teams, no billing, no user management. Multi-server from day one;
    multi-*user* deferred. Every entity that would need an owner gets one field,
    unused, rather than a retrofit later.

---

## Glossary

**Plane** — the control plane. The Cloudflare Worker holding all state and
logic, serving the REST API, the MCP server, the web UI, and the daemon
WebSocket endpoint.

**Daemon / `cockpitd`** — the Go binary on each managed server. Dials out to the
plane, reports observed state, executes tasks, streams logs and metrics.

**Install script** — the versioned shell script served by the plane
(`curl -fsSL <plane>/install.sh | sh`). Hardens the host, installs Docker and
`cockpitd`, and enrols the server. The only thing that ever runs directly on a
box outside the daemon.

**Enrolment token** — a short-lived, single-use secret embedded in the install
one-liner, produced when a server is created in a client. Exchanged by the daemon
on first connect for a long-lived per-server credential, then burned.

**Claim code** — the reverse-direction alternative: a short, short-lived,
single-use code the daemon prints when installed without a token, which the
operator redeems in any client to bind the box to a `Server`.

**Server** — a VPS under cockpit's management. Has exactly one daemon.

**Resource** — anything cockpit manages on a server. Identified by
`(server, kind, name)`. See `kind` below.

**Kind** — the type of a resource: `app`, `database`, `proxy`, `volume`,
`network`, `cron`, `daemon`, `firewall_rule`, `dns_record`. Each kind has a Zod
spec schema and a daemon handler, and nothing else.

**Spec** — the desired configuration of a resource. JSON, validated against its
kind's schema. The operator's intent.

**Observed state** — what the daemon actually found on the box. Never assumed,
always reported.

**Drift** — a difference between spec and observed state that no plan caused.

**Plan** — a proposed, typed, reviewable set of changes. The unit of change
(#6). Has a lifecycle: `pending → approved → applying → applied | failed`, plus
`reverted`.

**Change** — one entry in a plan: an op, a target, `before`, `after`,
`inverse`, `impact`.

**Impact** — how disruptive a change is: `none | reload | restart | replace |
destructive` (#15).

**Apply** — executing an approved plan. Runs as a Cloudflare Workflow, one
durable step per change.

**Release** — an immutable record written on each successful apply against a
resource: the full spec snapshot, image digest, and originating plan. Rollback
is re-applying release *N-1* (#8).

**Link** — a stored relationship between two resources (#11).

**Event** — an append-only record of something that happened: a plan applied, a
container died, disk pressure, an alert fired, an agent connected. The audit log
and the activity feed are both views over this.

**Actor** — who caused something: `{ kind: "human" | "agent" | "system", id }`.
Every plan and event carries one.

**Secret ref** — a provider-scheme string standing in for a secret (`op://…`),
resolved by the daemon on the box and never held by the plane (#15, ADR-0008).

---

## Conventions

- **Package manager**: pnpm workspaces. Never npm.
- **Task runner**: Makefile. Never run `package.json` scripts directly.
- **Validation**: Zod schemas in `packages/schema` are the single definition of
  every kind, op, and API payload. REST validation, MCP tool schemas, CLI flag
  parsing, and UI form shapes all derive from them. A kind defined twice is a
  bug.
- **Determinism**: no `Date.now()` or `Math.random()` in plane logic — clock and
  ID generation are injected, so plans and workflows are replayable and
  testable.
- **Design language**: paper-and-ink, inherited from `postern`. Monochrome
  canvas, one ink foreground at varying alpha, zero border radius, Schibsted
  Grotesk + Geist Mono. Colour carries meaning only: `accent` = healthy/applied,
  `info` = pending/neutral, `danger` = failed/destructive. In an infra dashboard
  this means a failing container is the only red thing on screen.
- **Naming**: resources are `(server, kind, name)`-unique. Names are
  kebab-case, stable, and operator-chosen.
