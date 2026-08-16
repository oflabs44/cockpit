# cockpit — Type Design (implementor handover)

The canonical type and protocol spec. An implementor should be able to build the
foundation from this document alone. Rationale lives in [`docs/adr/`](./adr/); term
definitions and the decision log in [`CONTEXT.md`](../CONTEXT.md). References like `(#7)`
point at `CONTEXT.md`.

All types below live in `packages/schema` as Zod schemas, with TypeScript types inferred
from them. They are written here as TypeScript for readability; the Zod schema is the
artifact, and it is the single definition from which REST validation, MCP tool schemas,
CLI flags, and UI forms all derive (#2, ADR-0005).

> ADR-0009 migrated `apps/plane` from the earlier Plan prototype to the entities and
> flows below. Add execution against this model.

---

## 1. Primitives

```ts
type Id<P extends string> = `${P}_${string}`   // srv_, prj_, res_, dep_, opn_, rel_, evt_, lnk_

type Actor =
  | { kind: 'human';  id: string }             // operator identity
  | { kind: 'agent';  id: string }             // e.g. 'claude-code'
  | { kind: 'system'; id: string }             // e.g. 'drift-sweep', 'health-monitor'

/** A pointer to a secret, never the secret. The scheme names the provider and
 *  is resolved by the daemon on the box, immediately before use (ADR-0008).
 *  v1 ships `op://` only; the others are reserved so adding one is a resolver
 *  plus a schema, not a migration. */
type SecretRef =
  | `op://${string}`      // 1Password — the only provider in v1
  | `aws://${string}`     // AWS Secrets Manager
  | `vault://${string}`   // HashiCorp Vault
  | `ck://${string}`      // cockpit-held, encrypted — possible, not planned

type Health = 'healthy' | 'degraded' | 'unhealthy' | 'stopped' | 'unknown'

/** Result of any ensure-semantics operation (#14). Inherited from yoke. */
type Changed = 'create' | 'in_place' | 'replace' | 'no_op'
```

No `Date.now()` or `Math.random()` in plane logic: clock and id generation are injected,
so deployments, operations, and workflows are replayable and testable.

---

## 2. Entities

### 2.1 Server

```ts
interface Server {
  id: Id<'srv'>
  name: string                       // kebab-case, operator-chosen, unique
  provider: 'hetzner' | 'digitalocean' | 'linode' | 'other'
  addr: string | null                // reported by the daemon; informational only.
                                     // Nothing in cockpit ever dials it (#4)
  arch: 'amd64' | 'arm64'
  status: 'enrolling' | 'connected' | 'disconnected' | 'draining'
  agent_version: string | null
  last_seen_at: number | null
  labels: Record<string, string>
  created_at: number
}
```

`status` is derived from the `ServerDO`'s connection state, not from polling. `addr` is
reported by the daemon and kept for the operator's benefit; cockpit never connects to it.

### 2.1.1 Enrolment

```ts
interface Enrolment {
  id: string
  server_id: Id<'srv'> | null        // null for claim-code flow until redeemed
  mode: 'token' | 'claim_code'
  secret_hash: string                // never stored in the clear
  /** What the enrolling daemon reported about itself, shown to the operator
   *  before binding so they can confirm it is the box they installed on. */
  presented: { hostname: string; arch: string; addr: string
               agent_version: string } | null
  expires_at: number                 // minutes, not hours
  consumed_at: number | null         // single-use
  created_by: Actor
  created_at: number
}
```

Both directions converge on the same exchange: the daemon presents a secret, the plane
validates it, issues a long-lived per-server credential, and burns the enrolment. Claim
codes are additionally rate-limited by IP and globally, being short enough to guess.

### 2.2 Project

A Project is one deployable GitHub-backed Compose stack on one server (ADR-0012). Git owns
workload topology; the Plane owns only target-specific bindings.

```ts
interface Project {
  id: Id<'prj'>
  server_id: Id<'srv'>
  source_id: Id<'src'>
  name: string
  repository_id: string              // authoritative identity; survives rename and transfer
  repository_full_name: string       // display cache only; stale after a rename
  ref: string
  base_directory: string
  compose_path: string
  auto_deploy: boolean
  settings: ProjectDeploymentSettings
  current_release_id: Id<'rel'> | null
  created_at: number
  updated_at: number
}
```

One repository can back several Projects through different base directories, Compose paths,
or refs. The Project is the deployment and release boundary.

`repository_id` is the repository's identity. `repository_full_name` is a display cache: it
is what an operator recognises the Project by, and it is wrong from the moment the repository
is renamed or transferred on github.com. Nothing may clone, fetch, authorize, or match a
webhook by the name. The fetch and preflight slice resolves the current clone identity from
`repository_id` through the installation, and a name that no longer matches is a display
value to refresh, not a Project to fail.

### 2.3 Service

A service is derived from the active effective Compose snapshot. It is a read model, not an
editable row of desired state. A container is an observed instance of a service.

```ts
interface ProjectService {
  project_id: Id<'prj'>
  name: string                        // Compose service key
  image: string | null
  health: Health
  exposed_at: string | null
  observed: Observed | null
  observed_at: number | null
}
```

Networks and volumes are Docker-managed primitives from the same Compose model. Domains,
Sources, and secret providers remain account-level integrations rather than containers.

### 2.4 Project deployment settings

The Plane does not copy or edit Compose service definitions. It stores only settings that
vary by target environment and generates a standard Compose override from them.

```ts
interface ProjectDeploymentSettings {
  ingress: {
    service: string
    port: number
    domains: string[]
  } | null
  migration: {
    service: string
    command?: string[]                // absent: use the service's Compose command
  } | null
  health: {
    required_services: string[]
  }
  variables: Record<string, string | SecretRef>
}
```

A variable value is an ordinary string the daemon passes through — including a plain URL —
or a `SecretRef`. Only the reserved-but-unresolvable schemes above (`aws://`, `vault://`,
`ck://`) are refused at the boundary, case-insensitively: storing one promises a dereference
at apply time that no resolver can perform. `https://` and `redis://` are values, not
references.

The daemon first normalizes the repository model and confirms every configured service
exists. It then normalizes that model with the Plane-generated override. A Deployment and
Release snapshot the final effective model; the repository file is never rewritten.

### 2.5 Observed

What the daemon actually found. Never assumed (#7).

```ts
interface Observed {
  exists: boolean
  health: Health
  detail: Record<string, unknown>    // kind-specific: container id, image digest,
                                     // uptime, restart count, ufw rule text, …
  observed_at: number
}
```

### 2.6 Recorded changes

A change is evidence inside a deployment or operation. It has no approval lifecycle.

```ts
type Impact = 'none' | 'reload' | 'restart' | 'replace' | 'destructive'

type ChangeAction = 'create' | 'update' | 'replace' | 'delete'

type ChangeTarget =
  | { kind: 'service'; project_id: Id<'prj'>; name: string }
  | { kind: 'network' | 'volume'; project_id: Id<'prj'>; name: string }

interface Change {
  action: ChangeAction
  target: ChangeTarget
  before: unknown | null             // null for creates
  after: unknown | null              // null for deletes
  impact: Impact
  result: 'pending' | 'applied' | 'failed' | 'skipped'
  error?: { kind: string; message: string }
}

interface ChangeSet {
  /** Observed revision used to calculate `before`. */
  basis_rev: number
  changes: Change[]
  max_impact: Impact                 // derived; never supplied by a client
  calculated_at: number
}
```

The planning step calculates the change set immediately before apply. The server Durable
Object serializes writes. If observed state changes before execution, Cockpit recalculates
inside the same run instead of creating a stale review object.

### 2.7 Deployment

A deployment belongs to one Project and applies its complete Compose stack.

```ts
interface SourceRevision {
  ref: string
  commit: string
  message: string | null
}

type DeploymentTrigger =
  | { kind: 'git_push'; source_id: Id<'src'>; revision: SourceRevision
      delivery_id: string }
  | { kind: 'manual'; commit: string | null }
  | { kind: 'redeploy'; deployment_id: Id<'dep'> }
  | { kind: 'rollback'; release_id: Id<'rel'> }

type DeploymentStatus =
  | 'queued' | 'fetching' | 'building' | 'planning'
  | 'deploying' | 'checking'
  | 'succeeded' | 'failed' | 'cancelled'

type DeploymentStepName =
  | 'source' | 'normalize' | 'build' | 'migration' | 'apply' | 'healthcheck'

interface DeploymentStep {
  name: DeploymentStepName
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'
  started_at: number | null
  finished_at: number | null
  error: { kind: string; message: string } | null
}

interface Deployment {
  id: Id<'dep'>
  project_id: Id<'prj'>
  server_id: Id<'srv'>
  trigger: DeploymentTrigger
  triggered_by: Actor
  status: DeploymentStatus
  source_revision: SourceRevision | null
  settings_snapshot: ProjectDeploymentSettings
  effective_compose: Record<string, unknown> | null
  compose_hash: string | null
  steps: DeploymentStep[]
  changes: ChangeSet | null
  workflow_id: string
  release_id: Id<'rel'> | null
  created_at: number
  started_at: number | null
  finished_at: number | null
}
```

A push webhook starts a deployment when its Source, repository, and ref match a Project.
The deployment snapshots Plane-owned settings at creation. A later settings edit cannot
alter that run.

### 2.8 Operation

An operation records a command that does not change the Project's Compose model.

```ts
type OperationKind =
  | 'service.start' | 'service.stop' | 'service.restart' | 'service.exec'
  | 'server.drain' | 'server.forget' | 'daemon.upgrade'

interface Operation {
  id: Id<'opn'>
  server_id: Id<'srv'>
  project_id: Id<'prj'> | null
  service_name: string | null
  kind: OperationKind
  actor: Actor
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  workflow_id: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
}
```

Destructive operation endpoints require explicit confirmation in their request. They fail
before execution when confirmation or authorization is absent.

### 2.9 Release

```ts
interface Release {
  id: Id<'rel'>
  project_id: Id<'prj'>
  rev: number                        // monotonic per Project
  deployment_id: Id<'dep'>
  effective_compose: Record<string, unknown>
  compose_hash: string
  runtime_snapshot: Record<string, unknown>
  source_revision: SourceRevision
  images: Record<string, { image: string; digest: string | null }>
  restored_from_release_id: Id<'rel'> | null
  status: 'active' | 'superseded'
  created_at: number
}
```

A release is written only after successful apply and health checks. The active release is
the Project's intended state. Rollback starts a new Deployment from an earlier Release;
it never reverses migrations or restores volume data.

### 2.10 Service graph

Service, network, volume, and dependency edges are derived from the active effective Compose
snapshot. The graph is read-only in Cockpit; changing it requires a source commit and
Deployment.

### 2.11 Event

Append-only. The audit log and the activity feed are both views over this.

```ts
interface Event {
  id: Id<'evt'>
  server_id: Id<'srv'> | null
  project_id: Id<'prj'> | null
  service_name: string | null
  deployment_id: Id<'dep'> | null
  operation_id: Id<'opn'> | null
  type: string                       // 'deployment.succeeded', 'container.died',
                                     // 'health.changed', 'disk.pressure',
                                     // 'daemon.connected', 'drift.detected', …
  actor: Actor
  payload: Record<string, unknown>
  at: number
}
```

---

## 3. Daemon protocol

One WebSocket per server, dialled **out** by the daemon to its `ServerDO` (ADR-0001).
JSON frames, each with a `type`. The daemon is stateless (#12); a task re-sent after a
reconnect is safe because all ops are idempotent (#13).

### 3.1 Daemon → plane

```ts
type Up =
  | { type: 'hello';    agent_version: string; arch: string; hostname: string
                        /** Enrolment secret on first contact; the per-server
                         *  credential thereafter. server_id is absent until bound. */
                        auth: { kind: 'enrolment' | 'credential'; secret: string }
                        server_id?: Id<'srv'> }
  | { type: 'awaiting_claim'; code: string }   // claim-code flow, before binding
  | { type: 'state';    rev: number; resources: ObservedResource[]
                        /** Host-level observed facts, added 2026-08-06: identity
                         *  (os, kernel, uptime), capacity (cpus, mem, disks, swap),
                         *  load, listeners, and the security baseline (sshd flags,
                         *  fail2ban, unattended-upgrades, last apt upgrade). Raw
                         *  values only — health thresholds are plane policy. */
                        host?: ObservedHost
                        /** Per-probe outcome, added 2026-08-06. Soft degradation means a
                         *  failed probe otherwise looks identical to an empty box — and a
                         *  change calculation would read "every firewall rule was
                         *  deleted". `unavailable` tells the plane to treat that kind's
                         *  absence as unknown, not as deletion. */
                        probes?: Record<'docker'|'firewall'|'systemd'|'cron'|'host',
                                        'ok' | 'unavailable'> }        // full snapshot,
                                                                       // on connect + interval
  | { type: 'event';    event: Omit<Event, 'id' | 'actor'> }
  | { type: 'deployment_progress'; deployment_id: Id<'dep'>
                        step: DeploymentStepName
                        status: 'started' | 'succeeded' | 'failed'
                        error?: { kind: string; message: string } }
  | { type: 'deployment_prepared'; deployment_id: Id<'dep'>
                        compose_hash: string
                        effective_compose: Record<string, unknown>
                        changes: ChangeSet }
  | { type: 'deployment_finished'; deployment_id: Id<'dep'>
                        images: Record<string, { image: string; digest: string | null }>
                        runtime: Record<string, unknown> }
  | { type: 'task_progress'; task_id: string; change_index: number
                        status: 'started' | 'ok' | 'error'
                        changed?: Changed; error?: { kind: string; message: string } }
  /** Outcome of a direct op, added 2026-08-06: without it a failed restart is
   *  indistinguishable plane-side from a successful no_op, and a refused frame
   *  from a dead daemon. Sent for every op — success, failure, or refusal.
   *  Task refusals answer too, as task_progress {status:'error',
   *  error:{kind:'refused', …}} at change_index 0. */
  | { type: 'op_result'; op_id: string; changed?: Changed
                         error?: { kind: string; message: string } }
  /** One ordered deployment-output chunk. For deployment logs, stream_id is the
   *  persisted Deployment id; a second deployment_id field would be ambiguous.
   *  `dropped` makes daemon-side loss explicit and `final` closes the stream. */
  | { type: 'stream_data'; stream_id: Id<'dep'>; seq: number
                          stage: 'fetch' | 'normalize' | 'build' | 'migrate' | 'apply' | 'health'
                          source: 'stdout' | 'stderr' | 'system'; data: string
                          at: number; dropped?: number; final?: boolean }
  | { type: 'metrics';  samples: MetricSample[] }
  | { type: 'pong' }

interface ObservedResource {
  kind: string
  name: string
  project_id?: Id<'prj'>
  release_id?: Id<'rel'>
  service_name?: string
  observed: Observed
}

/** Host-level half of a state snapshot (2026-08-06). Raw facts only — bytes,
 *  counts, and the words the source itself used. Thresholds (disk ≥ 80%,
 *  PermitRootLogin yes is red, …) are plane policy, never daemon logic.
 *  Mirrors daemon/internal/protocol/protocol.go, which is authoritative. */
interface ObservedHost {
  identity:  { os: string; kernel: string; hostname: string; uptime_s: number }
  capacity:  { cpus: number; mem_total: number; swap_total: number
               disks: { mount: string; size: number; used: number }[] }
  load:      [number, number, number]
  listeners: { proto: string; addr: string; port: number; pid_name: string }[]
  security:  { sshd: { permit_root_login: string; password_authentication: string
                       max_auth_tries: number }
               fail2ban_active: boolean
               unattended_upgrades_active: boolean
               last_apt_activity_unix: number }   // mtime of apt's history log —
}                                                 // any apt activity, not upgrades only
```

### 3.2 Plane → daemon

```ts
type Down =
  | { type: 'deployment_prepare'; deployment_id: Id<'dep'>; project_id: Id<'prj'>
      source: { repository: string; commit: string; token: string }
      base_directory: string; compose_path: string
      settings: ProjectDeploymentSettings }
  | { type: 'deployment_apply'; deployment_id: Id<'dep'>; compose_hash: string }
  | { type: 'deployment_cancel'; deployment_id: Id<'dep'> }
  /** Legacy resource-change task; retained until Project Compose execution replaces it. */
  | { type: 'task';   task_id: string
                      run: { kind: 'deployment'; id: Id<'dep'> }
                         | { kind: 'operation'; id: Id<'opn'> }
                      changes: Change[] }
  /** Bound to a recorded operation that leaves configuration unchanged. */
  | { type: 'op';     op_id: Id<'opn'>; project_id: Id<'prj'>
                      action: 'restart' | 'stop' | 'start'
                      service_name: string }
  | { type: 'op';     op_id: Id<'opn'>; project_id: Id<'prj'>; action: 'exec'
                      service_name: string; command: string[] }
  | { type: 'stream'; stream_id: string; action: 'start' | 'stop'
                      project_id: Id<'prj'>; service_name: string
                      source: 'logs' | 'stats' | 'build' }
  | { type: 'probe';  probe_id: string; project_id: Id<'prj'>; service_name?: string }
  | { type: 'ping' }
  /** The mandatory first frame answering a `hello`. `credential` is present only
   *  when the hello carried an enrolment secret (or a claim code was redeemed):
   *  the long-lived per-server credential the daemon must persist before sending
   *  anything else. Added 2026-08-05 — the original spec defined no down-frame
   *  acknowledging `hello` or delivering the credential §3.3 promises. */
  | { type: 'welcome'; server_id: Id<'srv'>; credential?: string }
```

### 3.3 Rules

- The daemon accepts deployment frames only for a persisted Project Deployment and `op`
  frames only for a persisted service Operation. The legacy `task` frame remains during
  migration and is then removed. This is the enforcement point for "nothing mutates
  unattributably" (ADR-0009) and must be covered by tests.
- An `op` completing triggers a fresh `state` snapshot. A restart is harmless, but `exec`
  can leave the box different from its current release, so Cockpit detects divergence
  immediately rather than at the next drift sweep.
- The daemon's authority is scoped to its own server; it can neither read nor act on
  another server's resources.
- `hello.auth` with `kind: 'enrolment'` is exchanged once for a long-lived per-server
  credential; the enrolment secret is burned on first use and cannot be replayed. Until
  that exchange succeeds the connection is untrusted and may do nothing but enrol.
- Every handshake is answered by a `welcome` before any other down-frame. In the
  claim-code flow the daemon sends `hello` (with no usable auth) plus `awaiting_claim`,
  and the `welcome` carrying the credential arrives only after the operator redeems the
  code in a client.
- `state.rev` is scoped to one daemon process: it restarts at 1 after a daemon restart.
  The plane reconciles per snapshot and keeps its own monotonic `observed_rev`; it must
  never compare `rev` across connections.
- Reconnect uses exponential backoff. On reconnect the daemon sends a full `state`, and
  the plane reconciles rather than assuming continuity.
- Ops execute with ensure-semantics and report `Changed` (#13). No "skip if exists"
  wrappers.

---

## 4. API surface

REST over Hono. Every route derives its validation from `packages/schema`, and every MCP
tool derives from the same definitions (ADR-0005). Listed by shape, not exhaustively.

```
  POST   /servers                        direct  → row + enrolment token
  GET    /servers                        list, with connection + health rollup
  GET    /servers/:id                    detail, observed state, resources
  PATCH  /servers/:id                    direct  — name, labels; no box change
  POST   /servers/:id/drain              Operation
  DELETE /servers/:id                    destructive Operation with confirmation
  GET    /enrolments                     pending, incl. claim codes awaiting redemption
  POST   /enrolments/:code/redeem        direct  — bind a claim-code daemon to a Server

  GET    /source-connections/:id/repositories  repositories granted to the installation

  GET    /projects                       ?server=
  POST   /projects/import                bind source + repository + ref + Compose path
  GET    /projects/:id                   project + active services
  PATCH  /projects/:id/settings          target-specific bindings; deploy separately
  GET    /projects/:id/services          derived from active effective Compose
  GET    /projects/:id/deployments
  POST   /projects/:id/deployments       manual deploy, redeploy, or rollback
  GET    /projects/:id/services/:name/logs
  GET    /projects/:id/services/:name/metrics
  POST   /projects/:id/services/:name/restart    direct Operation
  POST   /projects/:id/services/:name/stop       direct Operation
  POST   /projects/:id/services/:name/start      direct Operation
  POST   /projects/:id/services/:name/exec       direct Operation

  GET    /deployments/:id
  POST   /deployments/:id/cancel
  POST   /deployments/:id/retry
  GET    /deployments/:id/logs           live during the run, archived after

  GET    /operations/:id
  GET    /operations/:id/logs

  POST   /hooks/sources/:id              source-provider webhook; starts matching Projects

  GET    /domains  /sources  /secrets  /secret-providers
  POST   /domains  /sources  /secrets  /secret-providers    direct — account-scoped

  GET    /events                         the audit log / activity feed
  GET    /notifications                  the subset needing a human
  POST   /notifications/:id/read

  WS     /daemon                         cockpitd endpoint → ServerDO
  ALL    /mcp                            MCP server
  GET    /doc                            OpenAPI document
```

`install.sh` is deliberately **not** here. It is a static artifact fetched from a release
host, not a plane route — the enrolment token is an argument rather than something
templated in, so the file never varies and the plane never generates shell (§2.4).

Each endpoint is one `createRoute` from `@hono/zod-openapi`, carrying Zod request and
response schemas. That single definition produces the validation, the OpenAPI entry, and
the RPC types the web client infers — which is what makes ADR-0005 mechanical rather than
a convention.

`PATCH /projects/:id/settings` changes only Plane-owned target bindings. It does not send a
daemon frame. A Project Deployment snapshots those settings and an exact source revision
before changing the server (ADR-0009, ADR-0012).

A configured source webhook is an authorized deployment trigger. Manual Deploy, Redeploy,
and Rollback actions call the same Project deployment endpoint. Direct service commands
such as restart and exec create attributable Operations but no Release.

### MCP tools

Generated from the same schemas. Write tools mirror the API one-to-one. Read tools may be
grouped for agent ergonomics — for example one `project.context` tool returning a Project
with its services, logs, recent events, Deployments, and active Release — but a read
grouping may never become a write path that composes what the API cannot express
(ADR-0005).

---

## 5. Invariants to test

These are the properties that make the design true rather than aspirational. Each should
have a test that fails loudly if it erodes.

1. **Nothing mutates unattributably.** The daemon accepts deployment frames bound to a
   persisted Project Deployment and `op` frames bound to a recorded service Operation. It
   accepts nothing else (ADR-0009).
2. **Immutable run input.** A Deployment snapshots the source revision and Plane-owned
   Project settings before execution. Later edits cannot alter the run.
3. **Authorized pushes continue.** A valid webhook for a configured branch starts a
   deployment without creating a pending approval state.
4. **Drift uses the current release.** Plane settings alone do not mark a Project as
   drifted. Runtime differing from the active effective Compose snapshot does.
5. **Fresh changes.** The planning step calculates against observed state immediately
   before apply. If the basis changes, Cockpit recalculates inside the same serialized run.
6. **Idempotence.** Re-sending a deployment phase after reconnect does not duplicate a
   build, migration, service, network, or volume.
7. **No secret values anywhere.** Assert that no Project settings, Release snapshot, Event
   payload, source snapshot, or API response contains anything but `SecretRef` in a secret
   position. The plane has no code path that dereferences one (ADR-0008).
8. **Client parity.** For every write operation in `packages/schema`, assert that a REST
   route and an MCP tool exist and derive from the same definition.
9. **Impact is derived.** Clients cannot supply `max_impact`. Destructive endpoints require
   explicit confirmation before they create an operation.
10. **Git owns topology.** No Plane API edits a Compose service, network, or volume.
11. **Deployment ownership.** Every Deployment targets one Project and copies that
    Project's source, repository, ref, server id, and target settings.
12. **Determinism.** Plane logic contains no `Date.now()` or `Math.random()`; clock and id
    generation are injected.
13. **Compose policy is explicit.** Unsupported host access fails before build or apply;
    the daemon never silently drops or rewrites a requested capability.
14. **The git mirror is never read.** No code path in the plane reads from the mirror
    repository (ADR-0004).
15. **Enrolment secrets are single-use and expiring.** A consumed or expired token or claim
    code is rejected; an unenrolled connection can perform no operation but enrolment.
16. **Cockpit never opens an outbound connection to a managed server** (#4). Assert no SSH
    client and no raw socket to `Server.addr` anywhere in the plane or clients.
