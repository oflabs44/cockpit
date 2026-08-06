# cockpit — Architecture

Topology, technology choices, and the end-to-end flows. Rationale for the load-bearing
decisions lives in [`docs/adr/`](./adr/); term definitions and the numbered decision log
live in [`CONTEXT.md`](../CONTEXT.md). Decision references like `(#7)` point at
`CONTEXT.md`.

---

## 1. Topology

```
            ┌───────────┐        ┌────────────┐
            │  web UI   │        │  AI agent  │
            │ (browser) │        │   (MCP)    │
            └─────┬─────┘        └──────┬─────┘
                  │ REST + WS           │ MCP over HTTP
                  └──────────┬──────────┘
                             ▼
         ┌────────────────────────────────────┐
         │        PLANE — Cloudflare Worker   │
         │  Hono API · MCP server · web app   │
         │  D1 · Durable Objects · Workflows  │
         │  Queues · R2                       │
         └────────────────┬───────────────────┘
                          │  WSS, daemon dials out
         ┌────────────────┴───────────────────┐
         │   cockpitd (Go) on each server     │
         │   docker · ufw · systemd · cron    │
         └────────────────────────────────────┘

   onboarding — operator runs this on the box, once. A static script, not
   a plane endpoint; the token is an argument, so the file never varies:
     curl -fsSL https://get.cockpit.oflabs.dev/install.sh \
       | sh -s -- --plane <plane-url> --token <enrolment-token>
```

Every arrow points **away from** the servers. Four properties fall out of that, and
everything else depends on them:

- cockpit **never uses SSH** — not to execute, not to onboard (#4).
- The plane holds **no key material** and opens **no connections** to servers.
- Servers need **no inbound ports** and may sit behind NAT (ADR-0001).
- The plane runs on **none of the servers it manages**, so it survives their failure
  (#5, ADR-0002).

---

## 2. Technology

### 2.1 Plane — `apps/plane`

| concern | choice | notes |
|---|---|---|
| runtime | Cloudflare Workers, TypeScript | request-scoped; no module-level mutable state |
| HTTP | Hono + `@hono/zod-openapi` | one `createRoute` definition per endpoint yields request validation, the OpenAPI document, and RPC types together |
| relational state | D1 + Drizzle | servers, resources, plans, releases, events, links |
| long-running work | Workflows | one instance per apply; one durable step per change |
| fan-out / scheduled | Queues + Cron Triggers | health sweeps, backups, notification dispatch |
| live connections | Durable Objects | `ServerDO` (one per server, holds the daemon WSS), `StreamDO` (per resource log/metric stream). WebSocket hibernation so idle connections cost nothing |
| blobs | R2 | log archives, build logs, backup artifacts |
| validation | Zod 4 | from `packages/schema`; the single source for REST, MCP, and UI |
| MCP | Cloudflare Agents SDK (`McpAgent`, DO-backed) | same Worker; tools generated from the same schemas |
| auth | Cloudflare Access (UI) · `workers-oauth-provider` (MCP) | two authentication paths, one authorisation model (ADR-0005) |

The web app and the plane deploy as **one Worker** — UI assets, REST API, MCP
endpoint, and the daemon WebSocket endpoint on one origin. (Amended 2026-08-06:
via wrangler's native `assets` config on the plane — `apps/web` is a plain
Vite-built static bundle, `not_found_handling: single-page-application`, and
`run_worker_first` inverted so the Worker is the default and assets the
exception. `@cloudflare/vite-plugin` is not used: it exists to Vite-build the
Worker itself, and the plane is not Vite-built.)

**One route definition, three consumers.** `@hono/zod-openapi` takes a `createRoute`
carrying Zod request and response schemas, and from that single definition produces
validation at the boundary, an entry in the OpenAPI document at `/doc`, and the types the
RPC client infers. That is the mechanism behind ADR-0005 rather than a convention anyone
has to maintain:

- **Web app** — Hono RPC (`hc<AppType>`). Types flow from the route definitions with no
  codegen, so there is no generation step and no window in which a stale SDK disagrees with
  the server. This is `packages/client`.
- **MCP** — tools generated from the same route registry, since those definitions already
  carry both schemas. Going via the emitted OpenAPI JSON would be a lossy round-trip
  through a format that loses TypeScript types.
- **Anything external, later** — the OpenAPI document.

Middleware is deliberately short: `requestId` (to correlate a request with the `Event` it
produced), `secureHeaders`, `csrf` on mutating routes since Access is a cookie session,
`bodyLimit`, and `etag` for polled reads. **No `cors`** — everything is same-origin by
construction, and adding it would quietly permit the cross-origin calls that the
single-Worker deploy exists to make unnecessary.

Auth is two custom middlewares: Cloudflare Access JWT verification for UI routes, and
`workers-oauth-provider` for `/mcp`.

> **Caveat worth knowing early.** Hono's RPC type inference degrades IDE performance past a
> few dozen routes; the documented fix is to compile the types rather than infer them live.
> `packages/client` is a built package, so this is already the shape — but it constrains how
> the route surface is assembled.

**Why Durable Objects are load-bearing, not incidental.** A Worker is request-scoped and
stateless, but a daemon holds one long-lived WebSocket that needs somewhere with identity
and continuity to land. `ServerDO` — one per server, addressed by name — is that place,
and four things fall out of it at once:

- **Presence is a local question.** `prod-fsn1`'s socket lives in exactly one object, so
  "is this server connected" has a definite answer rather than needing a presence table.
- **Writes to a server serialise for free.** Two applies targeting the same box cannot
  race, because both pass through one object. That is otherwise a hard problem.
- **Observed state sits next to the connection that produced it.**
- **Fan-out has a home** — log and metric frames push to whoever is subscribed.

WebSocket hibernation is what makes it affordable: an idle server's DO evicts from memory
while keeping the socket open, so quiet boxes cost nothing.

`ServerDO` is not the only one — `StreamDO` is per log/metric stream and the MCP server is
DO-backed. The pattern is one DO per thing needing identity and continuity. Note what a DO
is **not**: truth. D1 holds servers, resources, plans, releases, and events (ADR-0004); the
DO holds the connection and the latest snapshot. Putting the audit trail inside a
per-server object would make it unqueryable across the fleet.

### 2.2 Web — `apps/web`

Mirrors `postern`'s stack and design language exactly.

| concern | choice |
|---|---|
| framework | TanStack Router, SPA mode (amended 2026-08-06 — Start was specified originally, but its current Cloudflare integration owns the Worker entrypoint (`@tanstack/react-start/server-entry` as `main`), which cannot compose with the plane's Hono app being the single Worker. Router-SPA keeps one origin and one Worker; revisit only if SSR becomes a requirement, which forces the bigger restructure of mounting Hono inside a Start server) |
| server state | TanStack Query, plus WebSocket subscriptions for live panels |
| build | Vite + `@cloudflare/vite-plugin` |
| primitives | Base UI (`@base-ui/react` (renamed from `@base-ui-components/react`)) |
| styling | Tailwind v4 (`@theme` in CSS, no config file) + `cva` + `clsx` + `tailwind-merge` |
| command palette | hand-built | ~80 lines, specified in `docs/design.md`. `cmdk` was considered and dropped: it brings its own DOM structure for behaviour already pinned down, and the palette doubles as every picker |
| icons | HugeIcons (`@hugeicons/core-free-icons`), geometry only — stroke, width, and caps set in CSS so the rounded caps it ships become square |
| fonts | Schibsted Grotesk (sans) + Geist Mono (mono), via fontsource |

**Design language — paper-and-ink, inherited from `postern`.** `paper` is the canvas,
`sheet` the panes, `ink` the single foreground at varying alpha. Zero border radius
everywhere. Emphasis reads through contrast, never colour.

Colour carries meaning only, and cockpit's states map onto the existing vocabulary:

| token | meaning in cockpit |
|---|---|
| `accent` (green) | healthy, running, applied |
| `info` (blue) | pending, planning, enrolling, neutral state action |
| `warn` (amber) | degraded, nearing a limit, needs attention |
| `danger` (red) | failed, unhealthy, destructive impact, alert firing |
| `ink` at reduced alpha | stopped, unknown, disabled |

This is a better fit for cockpit than for mail: an infra dashboard is a dense table of
state, and monochrome-with-three-accents means a failing container is the only red thing
on screen. Coolify's UX problem is partly that everything is coloured, so nothing is.

`postern`'s `--idhue` identity-tint mechanism is available for a **stable per-subject
hue**, but never on anything that also carries state. An early pass tinted server names
this way and produced red, green, and blue names — the exact hues that mean failing,
healthy, and pending — so a healthy box read as an alert. Reserved for subjects with no
status of their own: avatars, log-line gutters, graph series.

Components: local `components/ui/*` in postern's style (`Button`, `Input`, `IconButton`,
`Avatar`), plus cockpit-specific — `StatusDot`, `ResourceRow`, `PlanDiff`, `LogPane`,
`MetricSpark`, `FleetGraph`.

The command palette is load-bearing, not decoration: `⌘K` → "deploy jerry", "logs prod",
"restart db-jerry". For a terminal-first operator it is the cheapest large UX win over
Coolify.

### 2.3 Daemon — `daemon/`

Go. Static single binary, cross-compiled for `linux/amd64` and `linux/arm64`, installable
with one `curl`. No runtime dependency on the box beyond Docker.

**It has no listening port.** No HTTP, no gRPC, nothing to firewall. Its entire interface
is the outbound WebSocket, which is what makes it NAT-safe and why the plane holds no
credentials.

Four jobs, and only four:

1. **Observe** — enumerate containers, volumes, networks, UFW rules, systemd units, and
   cron entries, and report them as a `state` snapshot.
2. **Execute** — apply `task` frames (plan-bound) and `op` frames (event-bound) with
   ensure-semantics, reporting `create | in_place | replace | no_op`.
3. **Stream** — pump logs, build output, and metrics up the connection it already holds.
4. **Enrol** — once, at the start.

Everything it knows *how* to do is `yoke`'s command knowledge ported over: the exact
`docker run` invocations, UFW and cloud-firewall mediation, the healthcheck poll, typed
errors. That knowledge is the asset and it is transport-independent; only the transport is
new (ADR-0001).

**It holds no desired state and no database** (#13). The box is the truth. That is what
makes a task re-sent after a reconnect safe — every op is idempotent, so re-running yields
`no_op` rather than a duplicate.

```
dial ──▶ hello/auth ──▶ full state snapshot ──▶ serve
                                                  │
   ┌──────────────────────────────────────────────┤
   │  task  → run changes in order, task_progress per change
   │  op    → run one operation, emit Event, re-sync state
   │  stream→ start/stop a tail, pump stream_data
   │  probe → sample host or resource, reply
   └──▶ on disconnect: exponential backoff, redial, resend full state
```

**Executors sit behind interfaces** — `Docker`, `Firewall`, `Systemd`, `Cron` — so handler
logic runs against fakes with no box at all. Without that seam every test needs a VPS, and
tests that need a VPS stop being written. See `docs/development.md`.

### 2.4 Install script — `daemon/install.sh`

A **static bash script**, published as a release artifact and fetched over HTTPS. It is
not a Worker route and the plane does not generate it.

```
curl -fsSL https://get.cockpit.oflabs.dev/install.sh \
  | sh -s -- --plane https://cockpit.oflabs.dev --token ck_enrol_8fkq2t
```

It is idempotent and safe to re-run:

1. Detects distro and architecture.
2. Hardens the host — sshd, users, UFW baseline.
3. Installs Docker.
4. Installs the matching `cockpitd` binary and its systemd unit.
5. Enrols with the token if given one, otherwise prints a claim code.

**Why it is static, and not served by the plane.** The enrolment token is a command-line
*argument*, never templated into the file — so every server fetches byte-identical bytes,
and nothing about the script needs a running Worker. Three things follow:

- **The plane never generates shell.** A templated installer is a code-injection surface
  that has to be reasoned about on every change; a static file is not. Given this script
  is piped to a root shell, that difference is worth more than the convenience.
- **It becomes checksummable.** A fixed artifact can be published with a SHA-256 and
  verified in a two-step install for anyone who does not want `curl | sh`. A per-request
  script cannot be.
- **Onboarding survives the plane being down.** You can install the daemon on a fresh box
  while the control plane is unreachable; it enrols when the plane returns.

The cost is that **the script and the daemon version must be kept in step deliberately**,
since the plane is no longer in a position to serve the matching pair. The script resolves
the daemon version from the same release channel it was published in.

It replaces the `/devops` `bootstrap-server` playbook — prose an agent interpreted, so
three runs produced three subtly different boxes. A versioned script is identical on every
host and can be tested.

### 2.5 Repo layout

```
cockpit/
  apps/plane/         Worker: Hono API + MCP server + Workflows + Durable Objects
  apps/web/           TanStack Start UI (bundled into the plane Worker)
  daemon/             Go: cockpitd, plus install.sh
  packages/schema/    Zod: resource kinds, ops, plan/entity types   ← the spine
  packages/client/    Generated typed API client
  packages/types/     Shared TS types with zero runtime deps
  docs/
```

pnpm workspaces. Makefile as the task entrypoint. Never npm; never run `package.json`
scripts directly.

`packages/schema` is load-bearing: a kind, an op, or an API payload is defined **once**
there, and the REST handler, the MCP tool, and the UI form all derive
from that definition. A capability defined twice is a bug (#2, ADR-0005).

### 2.6 Deliberately not used

Kubernetes, Nomad, Terraform, Ansible; Traefik's file provider (Docker labels instead, so
cockpit owns no proxy config — #17); any ORM-driven admin scaffolding, which is the road
to Coolify's UX.

---

### 2.7 Projects

A **project** groups resources inside one server — an app plus the database, volume, and
cron that serve it. It is a nullable `project_id` on `Resource`, not a level above the
server and not a scope of its own (ADR-0007). A resource in no project is shared with the
whole server, and *shared* is derived rather than declared: anything two projects use, or
none do, is shared by definition.

The project's own view is its **dependency graph**, rendered from `Link` — see §3.6.

---

## 3. Flows

### 3.1 Onboard a server

No SSH, and no client on the critical path (ADR-0001). Two directions, same endpoint.

**Pre-authorised — the default.**

```
  1. operator, in UI or over MCP:  POST /servers
                                   → server row (status: enrolling)
                                   + short-lived single-use enrolment token
                                   + a copy-paste one-liner
  2. operator, on the box:         curl -fsSL <get>/install.sh
                                     | sh -s -- --plane <url> --token <tok>
                                   → harden, install Docker, install cockpitd
  3. daemon dials plane, presents the token
                                   → exchanged for a long-lived per-server
                                     credential; the enrolment token is burned
  4. daemon sends `state`          → observed state recorded, server `connected`
```

**Claim code — for boxes that predate cockpit.**

```
  1. operator, on the box:  curl -fsSL <get>/install.sh | sh -s -- --plane <url>
                            → daemon starts unbound, prints a short claim code
  2. daemon dials plane and waits, identified only by that code
  3. operator, in UI or over MCP:  redeem the code
                            → creates or binds the Server, issues the credential
  4. daemon sends `state`   → observed state recorded, server `connected`
```

Enrolment tokens and claim codes are short-lived (minutes) and single-use. Claim codes are
additionally rate-limited, being guessable in a way tokens are not. Before binding, the
plane surfaces the enrolling host's reported identity so the operator can confirm it is
the box they just installed on.

There is no break-glass path inside cockpit. If a daemon is down, the box is opaque; the
operator diagnoses over their own SSH and re-runs the install script, which is idempotent
and re-enrols. That is the trade for holding no standing fleet-wide credential anywhere.

### 3.2 Deploy an app

```
  intent ────▶ PLAN ────▶ approve ────▶ APPLY (Workflow) ────▶ RELEASE + EVENTS
```

1. Operator or agent submits an app spec (repo, branch, build, domain, ports, env refs,
   resource limits).
2. Plane diffs spec against the daemon's **observed** state (#7) and produces a `Plan`
   with per-change `impact`.
3. Client renders the plan. Approval is required; auto-approval is possible by policy for
   `impact: none | reload` only (ADR-0003).
4. Apply starts a Workflow. One durable step per change; the daemon executes each with
   ensure-semantics returning `create | in_place | replace | no_op` (#13).
5. For an app build, the daemon clones and builds **on the target server** (#16), under
   the spec's build limits, streaming build logs to a `StreamDO`.
6. Container starts with Traefik labels; Traefik reconfigures itself (#17). Healthcheck
   polls until healthy or the step fails.
7. On success, a `Release` row records the spec snapshot, image digest, and plan id.
   Events are emitted throughout. The git mirror commit is fired best-effort (ADR-0004).

Rollback is applying release *N-1*: a plan whose changes are the recorded inverses (#8).

### 3.3 Direct operations

Not every mutation is a plan (ADR-0003). Restart, stop, start, exec, and terminal leave the
spec identical, so they execute immediately:

```
  client ──▶ POST /resources/:id/restart
         ──▶ plane records an Event with the actor
         ──▶ ServerDO sends an `op` frame to the daemon
         ──▶ daemon executes, reports, and re-syncs observed state
```

The daemon accepts exactly two kinds of write frame: `task`, bound to a plan in
`applying`, and `op`, bound to a recorded event. An `op` may never carry a spec change —
that is what keeps the carve-out from becoming a loophole. Every operation forces a state
re-sync on completion, because an exec or a terminal session can leave the box diverged
from its spec.

### 3.4 Log streaming

```
docker logs -f ──▶ cockpitd ──WSS──▶ ServerDO ──▶ StreamDO ──WS──▶ browser
                                                          └──────▶ MCP
```

Recent lines live in the `StreamDO`; older lines archive to R2 on a rolling window. One
path, all clients (#1). The `/devops` observability playbook deliberately punted logs;
cockpit cannot.

### 3.5 Observation and drift

The daemon sends a full `state` message on connect and on an interval, plus `event`
messages in real time (container died, health changed, disk pressure). The plane stores
observed state per resource. A scheduled sweep plans every resource against its observed
state; any plan with changes nobody requested is surfaced as **drift** (#7).

### 3.6 The project canvas

A project renders as its dependency graph, drawn directly from `Link` rows — not a
visualisation layer over a list. It authors **composition** (add, remove, arrange) but not
connections: a link is created where it is configured, and the edge appears as a
consequence. This is Railway's split too, where connections come from reference variables
rather than a gesture. Node positions are persisted per project, since they are the
operator's mental map and cannot be recomputed on load.

### 3.7 An agent operating cockpit

Read side: one call returns a resource with its logs, metrics, recent events, recent
plans, and links — enough to diagnose an outage without fifteen round-trips (ADR-0005).

Write side: the agent proposes a `Plan`. It appears in the UI attributed to that agent,
with its diff and impact. The operator approves it in the UI. The agent cannot mutate
a server unilaterally, by construction (#3, ADR-0003).

---

## 4. Security model

- **No SSH anywhere in cockpit.** No component of the system holds a key that opens any
  box. Each daemon holds a per-server credential, individually revocable; a revoked daemon
  fails closed (ADR-0001).
- **Enrolment secrets are short-lived and single-use.** Tokens leak by construction — into
  shell history and the process list — so their value comes from expiring in minutes and
  binding exactly one server. Claim codes add rate limiting.
- **The install script is security-critical.** Piped to a root shell over HTTPS: versioned,
  integrity-verifiable, reproducible from the repo, templated with nothing but the plane
  URL and an enrolment token.
- **Daemon authority is scoped to its own server.** It cannot read or act on another
  server's resources.
- **Secrets are references, never values, resolved on the box** (#15, ADR-0008). Env
  values are provider-scheme refs (`op://…`) dereferenced by the **daemon** immediately
  before use. The plane never holds a value — giving it one would restore the blast radius
  that holding no SSH keys removes. The cost, accepted knowingly: a scoped provider
  credential lives on each server.
- **Every mutation is attributable.** Plans and events carry an `Actor`
  (`human | agent | system`).
- **Destructive changes are typed as such** (#15), so the gate cannot be forgotten.
- **The operator's own SSH remains theirs.** It is how they reach their box out-of-band,
  and cockpit neither uses it, stores it, nor needs to know it exists.

---

## 5. Known open questions

Deliberately unresolved; each will get its own ADR when forced.

0. **Drift, in the UI.** The plane detects drift for free — plans are computed against
   observed state (#7), so a plan containing changes nobody requested *is* drift. It is
   deliberately **not surfaced in v1's interface**: it needs a third status colour and a
   distinction ("running fine, but the record is no longer true") that is hard to explain
   before an operator has hit it. The capability stays; the presentation is deferred until
   there is evidence of how often it actually happens.

1. **Backups and tested restore** for stateful resources. The largest gap inherited from
   the `/devops` playbooks — `deploy-database` creates data that nothing protects. Needs a
   restore path that is exercised, not just a dump that is written.
2. **Metrics storage.** The daemon can ship metrics, but where they land (R2 + a
   time-series encoding, an embedded VictoriaMetrics per host as today, or a hosted sink)
   is unsettled.
3. **Provisioning.** Creating and destroying VPSes at a provider is currently outside
   cockpit, done with provider CLIs from the laptop. Whether the plane should hold
   provider tokens and provision directly is a real decision with a real blast radius.
4. **Daemon upgrade and version skew.** The plane knows every daemon's version and can
   drive a rollout; the compatibility policy between plane and daemon versions is not yet
   defined.
5. **Multi-server orchestration.** Private networking between boxes, and resources that
   span servers, are out of scope for v1.
6. **Build placement.** Building on the target server is v1 (#16). Moving to a dedicated
   builder or laptop-buildx-plus-registry is a later optimisation.
7. **Interactive terminals.** The transport already supports it — the daemon dials out, so
   a PTY works behind NAT with no inbound port, which is better than SSH-based platforms
   manage. What is missing is `pty_open`/`pty_data`/`pty_resize`/`pty_close` frames, a PTY
   on the box, a brokering DO, and xterm.js. Two positions to take deliberately when it
   ships: **container exec only, not a host shell** (the operator's own SSH stays theirs,
   so cockpit need not duplicate it and hold the risk), and **agents get one-shot `exec`,
   never an interactive PTY** — a live shell is unreviewable by construction. Sessions must
   be recorded as events with an archived transcript, since "what happened to prod at 3am"
   has to stay answerable.
8. **Notification read state.** `Event` has no `read_at`, and no notion of which events are
   notifications rather than log entries. The UI already draws an unread badge over
   nothing.
9. **Canvas layout persistence.** Node positions need a home in the schema.

10. **Secret providers beyond 1Password**, and how each one's credential reaches and
    rotates on a server. The resolution seam is settled (ADR-0008); the provider set is
    not. Also open: whether builds need secrets, and per-project shared secrets.

See also `docs/prototype-reality-check.md`, which traces every value the prototype renders
to the frame, query, or probe that would produce it, and lists the ones nothing does.
