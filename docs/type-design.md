# cockpit — Type Design (implementor handover)

The canonical type and protocol spec. An implementor should be able to build the
foundation from this document alone. Rationale lives in [`docs/adr/`](./adr/); term
definitions and the decision log in [`CONTEXT.md`](../CONTEXT.md). References like `(#7)`
point at `CONTEXT.md`.

All types below live in `packages/schema` as Zod schemas, with TypeScript types inferred
from them. They are written here as TypeScript for readability; the Zod schema is the
artifact, and it is the single definition from which REST validation, MCP tool schemas,
CLI flags, and UI forms all derive (#2, ADR-0005).

---

## 1. Primitives

```ts
type Id<P extends string> = `${P}_${string}`   // srv_, res_, pln_, rel_, evt_, lnk_

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

/** Result of any ensure-semantics op (#13). Inherited from yoke. */
type Changed = 'create' | 'in_place' | 'replace' | 'no_op'
```

No `Date.now()` or `Math.random()` in plane logic: clock and id generation are injected,
so plans and workflows are replayable and testable (CONTEXT conventions).

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

### 2.2 Resource

One polymorphic entity for everything managed on a server (ADR-0006).

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
  kind: Kind
  name: string                       // unique per (server_id, kind)
  spec: Spec                         // desired state, validated by the kind's schema
  spec_version: number               // schema version of `spec` (ADR-0006)

  // promoted from spec/observed for querying — never dug out of JSON at read time
  health: Health
  current_release: Id<'rel'> | null
  exposed_at: string | null          // primary domain, if any
  drifted: boolean

  observed: Observed | null          // last report from the daemon
  observed_rev: number               // bumped on every daemon state report
  observed_at: number | null

  created_at: number
  updated_at: number
}
```

`spec` is JSON in SQL, so relational constraints cannot police it. Zod at the API
boundary is the only validator, and every write path must pass through it (ADR-0006).

### 2.3 Spec, per kind

Each kind contributes one schema. This is the whole extension surface: **a new kind is a
spec schema plus a daemon handler, nothing else** (ADR-0006).

```ts
interface AppSpec {
  source:
    | { type: 'repo'; url: string; ref: string; path?: string }
    | { type: 'image'; image: string; digest?: string }
  build?: {
    dockerfile?: string
    args?: Record<string, string>
    limits: { cpu: string; memory: string }     // required (#16) — builds run on the
                                                // target server and must be bounded
    prune: { keep_layers: number }              // required (#16) — disk protection
  }
  domains: string[]                             // Traefik labels derive from these (#17)
  ports: { container: number; protocol: 'tcp' | 'udp' }[]
  env: Record<string, string | SecretRef>        // refs only (#15, ADR-0008)
  replicas: number
  healthcheck?: { path: string; interval_s: number; timeout_s: number; retries: number }
  limits: { cpu: string; memory: string }
  restart: 'always' | 'unless-stopped' | 'on-failure'
}

interface DatabaseSpec {
  engine: 'postgres' | 'redis'
  version: string
  volume: string                                // Link to a volume resource
  credentials: SecretRef                         // generated into the vault, never stored
  network: string                               // private `db-<name>` network by default
  expose: 'private' | 'host' | 'public'         // default 'private'
  backup?: { schedule: string; retain: number; destination: 'r2' }
}

interface CronSpec {
  schedule: string                              // cron expression
  timezone: string
  command: string
  env: Record<string, string | SecretRef>
  on_failure: 'ignore' | 'alert'
}

interface FirewallRuleSpec {
  port: number
  protocol: 'tcp' | 'udp'
  source: string                                // CIDR
  layer: 'ufw' | 'cloud' | 'both'               // UFW / provider firewall mediation
  purpose: string                               // required: why this rule exists
}

interface DnsRecordSpec {
  zone: string
  name: string
  type: 'A' | 'AAAA' | 'CNAME' | 'TXT'
  value: string
  proxied: boolean
}

// VolumeSpec, NetworkSpec, ProxySpec, DaemonSpec follow the same shape.
type Spec = AppSpec | DatabaseSpec | CronSpec | FirewallRuleSpec | DnsRecordSpec /* … */
```

`FirewallRuleSpec.purpose` is required by design: the `/devops` playbooks learned that an
undocumented open port is unauditable a month later.

### 2.4 Observed

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

### 2.5 Plan

The sole unit of change (#6, ADR-0003).

```ts
type Impact = 'none' | 'reload' | 'restart' | 'replace' | 'destructive'

type Op =
  | 'server.enrol'   | 'server.drain'    | 'server.forget'
  | 'resource.create'| 'resource.update' | 'resource.delete'
  | 'resource.start' | 'resource.stop'   | 'resource.restart'
  | 'release.rollback'
  | 'link.create'    | 'link.delete'
  | 'daemon.upgrade'

interface Change {
  op: Op
  target: Id<'res'> | Id<'srv'> | Id<'lnk'>
  before: unknown | null             // null for creates
  after: unknown | null              // null for deletes
  impact: Impact
  /** The change that undoes this one. Required unless `irreversible` (#8). */
  inverse: Omit<Change, 'inverse' | 'irreversible'> | null
  irreversible?: { reason: string }  // data loss, resource destruction
  status: 'pending' | 'applied' | 'failed' | 'skipped'
  error?: { kind: string; message: string }
}

interface Plan {
  id: Id<'pln'>
  status: 'pending' | 'approved' | 'applying' | 'applied' | 'failed' | 'reverted'
  changes: Change[]
  /** Observed revisions this plan was computed against; apply revalidates (ADR-0003). */
  basis: Record<Id<'res'>, number>
  summary: string                    // one line, human-readable
  max_impact: Impact                 // derived; drives the approval gate (#15)
  created_by: Actor
  approved_by: Actor | null
  workflow_id: string | null         // the Cloudflare Workflow instance
  created_at: number
  approved_at: number | null
  applied_at: number | null
}
```

Invariants: every `Change` has an `inverse` or an `irreversible`; `max_impact` is derived,
never supplied by a client; `basis` is captured at plan time and revalidated at apply.

### 2.6 Release

```ts
interface Release {
  id: Id<'rel'>
  resource_id: Id<'res'>
  rev: number                        // monotonic per resource
  spec_snapshot: Spec                // full spec as applied
  image_digest: string | null
  plan_id: Id<'pln'>
  status: 'active' | 'superseded' | 'rolled_back'
  created_at: number
}
```

Rollback to *N-1* is a plan whose changes restore that release's `spec_snapshot` (#8).
No bespoke rollback code exists.

### 2.7 Link

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

Deleting a resource with inbound links produces a `destructive` plan that names every
dependant. Dangling links are a tested bug class.

### 2.8 Event

Append-only. The audit log and the activity feed are both views over this.

```ts
interface Event {
  id: Id<'evt'>
  server_id: Id<'srv'> | null
  resource_id: Id<'res'> | null
  plan_id: Id<'pln'> | null
  type: string                       // 'plan.applied', 'container.died',
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
  | { type: 'state';    rev: number; resources: ObservedResource[] }   // full snapshot,
                                                                       // on connect + interval
  | { type: 'event';    event: Omit<Event, 'id' | 'actor'> }
  | { type: 'task_progress'; task_id: string; change_index: number
                        status: 'started' | 'ok' | 'error'
                        changed?: Changed; error?: { kind: string; message: string } }
  | { type: 'stream_data'; stream_id: string; lines: string[] }
  | { type: 'metrics';  samples: MetricSample[] }
  | { type: 'pong' }

interface ObservedResource { kind: Kind; name: string; observed: Observed }
```

### 3.2 Plane → daemon

```ts
type Down =
  /** Bound to a plan in `applying`. Changes desired state. */
  | { type: 'task';   task_id: string; plan_id: Id<'pln'>; changes: Change[] }
  /** Bound to a recorded Event. A direct operation — restart, stop, start —
   *  that leaves the spec identical (ADR-0003). May NEVER carry a spec change;
   *  that restriction is what keeps the carve-out from being a loophole. */
  | { type: 'op';     op_id: string; event_id: Id<'evt'>
                      action: 'restart' | 'stop' | 'start'
                      resource_id: Id<'res'> }
  | { type: 'stream'; stream_id: string; action: 'start' | 'stop'
                      resource_id: Id<'res'>; source: 'logs' | 'stats' | 'build' }
  | { type: 'probe';  probe_id: string; kind: 'host' | 'resource'; target?: Id<'res'> }
  | { type: 'exec';   exec_id: string; resource_id: Id<'res'>; command: string[] }
  | { type: 'ping' }
  /** The mandatory first frame answering a `hello`. `credential` is present only
   *  when the hello carried an enrolment secret (or a claim code was redeemed):
   *  the long-lived per-server credential the daemon must persist before sending
   *  anything else. Added 2026-08-05 — the original spec defined no down-frame
   *  acknowledging `hello` or delivering the credential §3.3 promises. */
  | { type: 'welcome'; server_id: Id<'srv'>; credential?: string }
```

### 3.3 Rules

- The daemon accepts exactly two write frames and nothing else: `task`, only for changes
  belonging to a plan in `applying`, and `op`, only bound to a recorded `Event`. This is
  the enforcement point for "nothing mutates unattributably" (ADR-0003) and must be
  covered by tests.
- An `op` completing triggers a fresh `state` snapshot. A restart is harmless, but `exec`
  and terminals can leave the box diverged from its spec, so the divergence is detected
  immediately rather than at the next planner run.
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
  POST   /servers/:id/drain              plan
  DELETE /servers/:id                    plan    — destructive
  GET    /enrolments                     pending, incl. claim codes awaiting redemption
  POST   /enrolments/:code/redeem        direct  — bind a claim-code daemon to a Server

  GET    /resources                      ?server= &kind= &project= &health=
  GET    /resources/:id                  detail + links + current release
  GET    /resources/:id/deployments
  GET    /resources/:id/links
  GET    /resources/:id/logs             SSE/WS stream, or historical from R2
  GET    /resources/:id/metrics
  POST   /resources/:id/restart          op      → Event
  POST   /resources/:id/stop             op      → Event
  POST   /resources/:id/start            op      → Event
  POST   /resources/:id/exec             op      → Event

  GET    /projects                       ?server=
  GET    /projects/:id
  POST   /projects                       direct  — grouping metadata only
  PATCH  /projects/:id/layout            direct  — canvas node positions

  POST   /plans                          propose: desired specs → Plan (never applies)
  GET    /plans                          filter by status, actor, server
  GET    /plans/:id
  POST   /plans/:id/approve
  POST   /plans/:id/apply                starts the Workflow
  POST   /plans/:id/revert               → a new plan of inverses

  GET    /deployments/:id
  GET    /deployments/:id/logs           live while applying, archived after

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

Note the asymmetry, which is the design (ADR-0003): **there is no
`PATCH /resources/:id`.** Every change to a resource's spec goes through `POST /plans`.
That absence is the architecture.

The direct endpoints — `restart`, `stop`, `start`, `exec` — are the carve-out: they leave
the spec identical, so they execute immediately and are recorded as `Event`s. Anything that
would change what a resource *is* has no direct path at all.

### MCP tools

Generated from the same schemas. Write tools mirror the API one-to-one. Read tools may be
grouped for agent ergonomics — for example one `resource.context` tool returning a
resource with its logs, metrics, recent events, recent plans, and links — but a read
grouping may never become a write path that composes what the API cannot express
(ADR-0005).

---

## 5. Invariants to test

These are the properties that make the design true rather than aspirational. Each should
have a test that fails loudly if it erodes.

1. **Nothing mutates unattributably.** The daemon accepts `task` frames bound to a plan in
   `applying`, and `op` frames bound to a recorded `Event`. It accepts nothing else, and
   an `op` may never carry a change to spec — that is what makes the carve-out safe rather
   than a loophole (ADR-0003).
2. **Inverse coverage.** Every `Change` produced by the planner carries an `inverse` or an
   `irreversible` with a reason. Property-test across all ops.
3. **Plans diff observed, not desired-last-known** (#7). A resource changed out-of-band
   produces a plan describing the difference — that is the drift test.
4. **Stale plans are rejected.** Apply revalidates `basis` against current `observed_rev`
   and refuses rather than force-applying.
5. **Idempotence.** Re-sending a task after reconnect produces `no_op`, not a duplicate
   resource.
6. **No secret values anywhere.** Assert that no `Spec`, `Release.spec_snapshot`, `Event`
   payload, git snapshot, or API response contains anything but `SecretRef` in a secret
   position — and that the plane has no code path that dereferences one (ADR-0008). The
   second half matters more: the first is a data check, the second is what stops the
   easy-but-wrong implementation.
7. **Client parity.** For every write operation in `packages/schema`, assert that a REST
   route and an MCP tool exist and are generated from the same definition. With no CLI,
   this test is the *only* mechanical guard on ADR-0005, so it is not optional.
8. **`max_impact` is derived**, never accepted from a client; `destructive` plans always
   require explicit approval and are never auto-approved.
9. **Links never dangle.** Deleting a linked resource either fails or produces a plan that
   removes the links, and always names the dependants.
10. **Determinism.** Plane logic contains no `Date.now()` or `Math.random()`; clock and id
    generation are injected.
11. **Kind extensibility.** Adding a kind touches exactly two places: a spec schema and a
    daemon handler. A test asserts the generic API, plan, release, and event paths need no
    change.
12. **The git mirror is never read.** No code path in the plane reads from the mirror
    repository (ADR-0004).
13. **Enrolment secrets are single-use and expiring.** A consumed or expired token or claim
    code is rejected; an unenrolled connection can perform no operation but enrolment.
14. **cockpit never opens an outbound connection to a managed server** (#4). Assert no SSH
    client, no raw socket to `Server.addr`, anywhere in the plane or the CLI.
