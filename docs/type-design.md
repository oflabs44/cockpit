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

A project groups related resources on one server. It is a navigation and ownership
boundary, not an execution unit. One project can contain multiple apps that deploy
independently.

```ts
interface Project {
  id: Id<'prj'>
  server_id: Id<'srv'>
  name: string
  created_at: number
  updated_at: number
}
```

### 2.3 Resource

One polymorphic entity for everything Cockpit manages (ADR-0006).

```ts
type Scope = 'server' | 'account'

/** Server-scoped: exists on a box, dies with it, reported by the daemon. */
type ServerKind =
  | 'app' | 'database' | 'proxy' | 'volume' | 'network'
  | 'cron' | 'daemon' | 'firewall_rule'

/** Account-scoped: outlives any box, linked to the spine rather than inside it. */
type AccountKind =
  | 'domain' | 'dns_record' | 'source' | 'secret' | 'secret_provider'
  | 'backup_destination'

type Kind = ServerKind | AccountKind

interface Resource {
  id: Id<'res'>
  /** Null for account-scoped kinds — domain, dns_record, source, secret,
   *  backup_destination. Those have no box (#11, ADR-0007). */
  server_id: Id<'srv'> | null
  /** Required for apps. Null for account-scoped or server-shared resources. */
  project_id: Id<'prj'> | null
  kind: Kind
  name: string                       // unique per (server_id, kind)
  configuration: Configuration       // saved input for the next deployment or apply
  configuration_version: number      // schema version of `configuration`

  // The current release, not editable configuration, defines intended running state.
  current_release_id: Id<'rel'> | null

  // promoted for querying — never dug out of JSON at read time
  health: Health
  exposed_at: string | null          // primary domain, if any
  drifted: boolean

  observed: Observed | null          // last report from the daemon
  observed_rev: number               // bumped on every daemon state report
  observed_at: number | null

  created_at: number
  updated_at: number
}
```

Saving `configuration` does not change the server. A deployment or configuration apply
takes an immutable snapshot before execution. `has_unapplied_changes` is derived by
comparing the saved configuration with the current release's configuration snapshot.

Configuration is JSON in SQL, so relational constraints cannot police it. Zod at the API
boundary is the validator, and every write path must pass through it (ADR-0006).

### 2.4 Configuration, per kind

Each kind contributes one schema. A new kind is a configuration schema plus a daemon
handler (ADR-0006).

```ts
interface AppConfiguration {
  source:
    | { type: 'repo'; url: string; ref: string; path?: string }
    | { type: 'image'; image: string; digest?: string }
  build?: {
    dockerfile?: string
    args?: Record<string, string>
    limits: { cpu: string; memory: string }     // required (#17) — builds run on the
                                                // target server and must be bounded
    prune: { keep_layers: number }              // required (#17) — disk protection
  }
  domains: string[]                             // Traefik labels derive from these (#17)
  ports: { container: number; protocol: 'tcp' | 'udp' }[]
  env: Record<string, string | SecretRef>        // refs only (#15, ADR-0008)
  replicas: number
  healthcheck?: { path: string; interval_s: number; timeout_s: number; retries: number }
  limits: { cpu: string; memory: string }
  restart: 'always' | 'unless-stopped' | 'on-failure'
}

interface DatabaseConfiguration {
  engine: 'postgres' | 'redis'
  version: string
  volume: string                                // Link to a volume resource
  credentials: SecretRef                         // generated into the vault, never stored
  network: string                               // private `db-<name>` network by default
  expose: 'private' | 'host' | 'public'         // default 'private'
  backup?: { schedule: string; retain: number; destination: 'r2' }
}

interface CronConfiguration {
  schedule: string                              // cron expression
  timezone: string
  command: string
  env: Record<string, string | SecretRef>
  on_failure: 'ignore' | 'alert'
}

interface FirewallRuleConfiguration {
  port: number
  protocol: 'tcp' | 'udp'
  source: string                                // CIDR
  layer: 'ufw' | 'cloud' | 'both'               // UFW / provider firewall mediation
  purpose: string                               // required: why this rule exists
}

interface DnsRecordConfiguration {
  zone: string
  name: string
  type: 'A' | 'AAAA' | 'CNAME' | 'TXT'
  value: string
  proxied: boolean
}

// VolumeConfiguration, NetworkConfiguration, ProxyConfiguration, and
// DaemonConfiguration follow the same shape.
type Configuration =
  | AppConfiguration
  | DatabaseConfiguration
  | CronConfiguration
  | FirewallRuleConfiguration
  | DnsRecordConfiguration
  /* … */
```

`FirewallRuleConfiguration.purpose` is required by design: the `/devops` playbooks
learned that an
undocumented open port is unauditable a month later.

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

interface Change {
  action: ChangeAction
  target: Id<'res'> | Id<'srv'> | Id<'lnk'>
  before: unknown | null             // null for creates
  after: unknown | null              // null for deletes
  impact: Impact
  result: 'pending' | 'applied' | 'failed' | 'skipped'
  error?: { kind: string; message: string }
}

interface ChangeSet {
  /** Observed revisions used to calculate `before`. */
  basis: Record<Id<'res'>, number>
  changes: Change[]
  max_impact: Impact                 // derived; never supplied by a client
  calculated_at: number
}
```

The planning step calculates the change set immediately before apply. The server Durable
Object serializes writes. If observed state changes before execution, Cockpit recalculates
inside the same run instead of creating a stale review object.

### 2.7 Deployment

A deployment belongs to one app resource. A project page aggregates the deployments from
all app resources in that project.

```ts
interface SourceRevision {
  ref: string
  commit: string
  message: string | null
}

type DeploymentTrigger =
  | { kind: 'git_push'; source_id: Id<'res'>; revision: SourceRevision
      delivery_id: string }
  | { kind: 'manual'; commit: string | null }
  | { kind: 'redeploy'; deployment_id: Id<'dep'> }
  | { kind: 'rollback'; release_id: Id<'rel'> }

type DeploymentStatus =
  | 'queued' | 'fetching' | 'building' | 'planning'
  | 'deploying' | 'checking'
  | 'succeeded' | 'failed' | 'cancelled'

type DeploymentStepName =
  | 'source' | 'build' | 'changes' | 'apply' | 'healthcheck'

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
  app_id: Id<'res'>
  server_id: Id<'srv'>
  trigger: DeploymentTrigger
  triggered_by: Actor
  status: DeploymentStatus
  source_revision: SourceRevision | null
  configuration_snapshot: AppConfiguration
  configuration_version: number
  steps: DeploymentStep[]
  changes: ChangeSet | null
  workflow_id: string
  release_id: Id<'rel'> | null
  created_at: number
  started_at: number | null
  finished_at: number | null
}
```

A push webhook starts a deployment when its source and ref match an app configuration.
The deployment snapshots configuration at creation. A later edit cannot alter that run.

### 2.8 Operation

An operation records a non-deployment action. Resource configuration applies create a
release. Commands that leave configuration unchanged do not.

```ts
type OperationKind =
  | 'resource.apply' | 'resource.rollback' | 'resource.delete'
  | 'resource.start' | 'resource.stop' | 'resource.restart' | 'resource.exec'
  | 'server.drain' | 'server.forget' | 'daemon.upgrade'

interface Operation {
  id: Id<'opn'>
  server_id: Id<'srv'>
  project_id: Id<'prj'> | null
  resource_id: Id<'res'> | null
  kind: OperationKind
  actor: Actor
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  configuration_snapshot: Configuration | null
  changes: ChangeSet | null
  workflow_id: string | null
  release_id: Id<'rel'> | null
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
  resource_id: Id<'res'>
  rev: number                        // monotonic per resource
  deployment_id: Id<'dep'> | null
  operation_id: Id<'opn'> | null
  configuration_snapshot: Configuration
  runtime_snapshot: Record<string, unknown>
  source_revision: SourceRevision | null
  image_digest: string | null
  restored_from_release_id: Id<'rel'> | null
  status: 'active' | 'superseded'
  created_at: number
}
```

A release is written only after successful apply and health checks. The current release
is the intended running state. App rollback starts a deployment from an earlier release.
A supported non-app restore starts an operation. Both write a new release with
`restored_from_release_id` set (#8).

### 2.10 Link

Stored relationships (#11, ADR-0006). A closed vocabulary, so the graph stays queryable.

```ts
type LinkKind = 'uses' | 'exposed_at' | 'depends_on' | 'backs_up' | 'routes_to'

interface Link {
  id: Id<'lnk'>
  from: Id<'res'>
  to: Id<'res'>
  kind: LinkKind
  created_at: number
}
```

Deleting a resource with inbound links creates a destructive operation that names every
dependant. Dangling links are a tested bug class.

### 2.11 Event

Append-only. The audit log and the activity feed are both views over this.

```ts
interface Event {
  id: Id<'evt'>
  server_id: Id<'srv'> | null
  project_id: Id<'prj'> | null
  resource_id: Id<'res'> | null
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
  | { type: 'stream_data'; stream_id: string; lines: string[] }
  | { type: 'metrics';  samples: MetricSample[] }
  | { type: 'pong' }

interface ObservedResource { kind: Kind; name: string; observed: Observed }

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
  /** Bound to a running deployment or configuration-apply operation. */
  | { type: 'task';   task_id: string
                      run: { kind: 'deployment'; id: Id<'dep'> }
                         | { kind: 'operation'; id: Id<'opn'> }
                      changes: Change[] }
  /** Bound to a recorded operation that leaves configuration unchanged. */
  | { type: 'op';     op_id: Id<'opn'>
                      action: 'restart' | 'stop' | 'start'
                      resource_id: Id<'res'> }
  | { type: 'op';     op_id: Id<'opn'>; action: 'exec'
                      resource_id: Id<'res'>; command: string[] }
  | { type: 'stream'; stream_id: string; action: 'start' | 'stop'
                      resource_id: Id<'res'>; source: 'logs' | 'stats' | 'build' }
  | { type: 'probe';  probe_id: string; kind: 'host' | 'resource'; target?: Id<'res'> }
  | { type: 'ping' }
  /** The mandatory first frame answering a `hello`. `credential` is present only
   *  when the hello carried an enrolment secret (or a claim code was redeemed):
   *  the long-lived per-server credential the daemon must persist before sending
   *  anything else. Added 2026-08-05 — the original spec defined no down-frame
   *  acknowledging `hello` or delivering the credential §3.3 promises. */
  | { type: 'welcome'; server_id: Id<'srv'>; credential?: string }
```

### 3.3 Rules

- The daemon accepts exactly two write frames and nothing else: `task`, only for a running
  deployment or configuration-apply operation, and `op`, only for a recorded direct
  operation. This is the enforcement point for "nothing mutates unattributably"
  (ADR-0009) and must be covered by tests.
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

  GET    /resources                      ?server= &kind= &project= &health=
  GET    /resources/:id                  detail + links + current release
  PATCH  /resources/:id/configuration    save only; does not change the server
  GET    /resources/:id/deployments      app resources only
  POST   /resources/:id/deployments      manual deploy, redeploy, or rollback
  POST   /resources/:id/apply            apply non-app configuration → Operation
  GET    /resources/:id/links
  GET    /resources/:id/logs             SSE/WS stream, or historical from R2
  GET    /resources/:id/metrics
  POST   /resources/:id/restart          direct Operation
  POST   /resources/:id/stop             direct Operation
  POST   /resources/:id/start            direct Operation
  POST   /resources/:id/exec             direct Operation

  GET    /projects                       ?server=
  GET    /projects/:id
  POST   /projects                       direct  — grouping metadata only
  PATCH  /projects/:id/layout            direct  — canvas node positions
  GET    /projects/:id/deployments       aggregate deployments from project apps

  GET    /deployments/:id
  POST   /deployments/:id/cancel
  POST   /deployments/:id/retry
  GET    /deployments/:id/logs           live during the run, archived after

  GET    /operations/:id
  GET    /operations/:id/logs

  POST   /hooks/sources/:id              source-provider webhook; starts matching apps

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

`PATCH /resources/:id/configuration` changes stored input only. It does not send a daemon
frame. An app deployment or non-app apply operation snapshots that configuration before it
changes the server (ADR-0009).

A configured source webhook is an authorized deployment trigger. Manual Deploy, Redeploy,
and Rollback actions call the same deployment endpoint. Direct commands such as restart
and exec create attributable operations but no release.

### MCP tools

Generated from the same schemas. Write tools mirror the API one-to-one. Read tools may be
grouped for agent ergonomics — for example one `resource.context` tool returning a
resource with its logs, metrics, recent events, deployments, and links — but a read
grouping may never become a write path that composes what the API cannot express
(ADR-0005).

---

## 5. Invariants to test

These are the properties that make the design true rather than aspirational. Each should
have a test that fails loudly if it erodes.

1. **Nothing mutates unattributably.** The daemon accepts `task` frames bound to a running
   deployment or operation, and `op` frames bound to a recorded direct operation. It
   accepts nothing else (ADR-0009).
2. **Immutable run input.** A deployment or configuration apply snapshots the source
   revision and saved configuration before execution. Later edits cannot alter the run.
3. **Authorized pushes continue.** A valid webhook for a configured branch starts a
   deployment without creating a pending approval state.
4. **Drift uses the current release.** Saved but unapplied configuration does not mark a
   resource as drifted. An out-of-band runtime change does.
5. **Fresh changes.** The planning step calculates against observed state immediately
   before apply. If the basis changes, Cockpit recalculates inside the same serialized run.
6. **Idempotence.** Re-sending a task after reconnect produces `no_op`, not a duplicate
   resource.
7. **No secret values anywhere.** Assert that no `Configuration`, release snapshot, event
   payload, git snapshot, or API response contains anything but `SecretRef` in a secret
   position. The plane has no code path that dereferences one (ADR-0008).
8. **Client parity.** For every write operation in `packages/schema`, assert that a REST
   route and an MCP tool exist and derive from the same definition.
9. **Impact is derived.** Clients cannot supply `max_impact`. Destructive endpoints require
   explicit confirmation before they create an operation.
10. **Links never dangle.** Deleting a linked resource either fails or records removal of
    its links and names the dependants.
11. **Deployment ownership.** Every app belongs to one project. A deployment targets one
    app and copies that app's project and server ids.
12. **Determinism.** Plane logic contains no `Date.now()` or `Math.random()`; clock and id
    generation are injected.
13. **Kind extensibility.** Adding a kind touches one configuration schema and one daemon
    handler. Generic operation, release, event, and API paths need no change.
14. **The git mirror is never read.** No code path in the plane reads from the mirror
    repository (ADR-0004).
15. **Enrolment secrets are single-use and expiring.** A consumed or expired token or claim
    code is rejected; an unenrolled connection can perform no operation but enrolment.
16. **Cockpit never opens an outbound connection to a managed server** (#4). Assert no SSH
    client and no raw socket to `Server.addr` anywhere in the plane or clients.
