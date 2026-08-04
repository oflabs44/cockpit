# cockpit — Architecture

Topology, technology choices, and the end-to-end flows. Rationale for the load-bearing
decisions lives in [`docs/adr/`](./adr/); term definitions and the numbered decision log
live in [`CONTEXT.md`](../CONTEXT.md). Decision references like `(#7)` point at
`CONTEXT.md`.

---

## 1. Topology

```
   ┌───────────┐   ┌────────────┐   ┌────────────┐
   │  web UI   │   │ cockpit CLI│   │  AI agent  │
   │ (browser) │   │  (laptop)  │   │   (MCP)    │
   └─────┬─────┘   └──────┬─────┘   └──────┬─────┘
         │ REST + WS      │ REST           │ MCP over HTTP
         └────────────────┼────────────────┘
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

   onboarding — operator runs this on the box, once:
         curl -fsSL <plane>/install.sh | sh -s -- --token <enrolment-token>
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
| HTTP | Hono | routing, middleware, typed handlers |
| relational state | D1 + Drizzle | servers, resources, plans, releases, events, links |
| long-running work | Workflows | one instance per apply; one durable step per change |
| fan-out / scheduled | Queues + Cron Triggers | health sweeps, backups, notification dispatch |
| live connections | Durable Objects | `ServerDO` (one per server, holds the daemon WSS), `StreamDO` (per resource log/metric stream). WebSocket hibernation so idle connections cost nothing |
| blobs | R2 | log archives, build logs, backup artifacts |
| validation | Zod 4 | from `packages/schema`; the single source for REST, MCP, CLI, UI |
| MCP | Cloudflare Agents SDK (`McpAgent`, DO-backed) | same Worker; tools generated from the same schemas |
| auth | Cloudflare Access (UI) · `workers-oauth-provider` (MCP) · device-flow token (CLI) | three authentication paths, one authorisation model (ADR-0005) |

The web app and the plane deploy as **one Worker** via `@cloudflare/vite-plugin` — UI
assets, REST API, MCP endpoint, and the daemon WebSocket endpoint on one origin.

### 2.2 Web — `apps/web`

Mirrors `postern`'s stack and design language exactly.

| concern | choice |
|---|---|
| framework | TanStack Start + TanStack Router |
| server state | TanStack Query, plus WebSocket subscriptions for live panels |
| build | Vite + `@cloudflare/vite-plugin` |
| primitives | Base UI (`@base-ui-components/react`) |
| styling | Tailwind v4 (`@theme` in CSS, no config file) + `cva` + `clsx` + `tailwind-merge` |
| command palette | `cmdk` |
| icons | Tabler |
| fonts | Schibsted Grotesk (sans) + Geist Mono (mono), via fontsource |

**Design language — paper-and-ink, inherited from `postern`.** `paper` is the canvas,
`sheet` the panes, `ink` the single foreground at varying alpha. Zero border radius
everywhere. Emphasis reads through contrast, never colour.

Colour carries meaning only, and cockpit's states map onto the existing vocabulary:

| token | meaning in cockpit |
|---|---|
| `accent` (green) | healthy, running, applied |
| `info` (blue) | pending, planning, neutral state action |
| `danger` (red) | failed, unhealthy, destructive impact, alert firing |
| `ink` at reduced alpha | stopped, unknown, disabled, drifted |

This is a better fit for cockpit than for mail: an infra dashboard is a dense table of
state, and monochrome-with-three-accents means a failing container is the only red thing
on screen. Coolify's UX problem is partly that everything is coloured, so nothing is.

`postern`'s `--idhue` identity-tint mechanism generalises to a **stable per-server and
per-app hue**, so a log line or a resource row is identifiable at a glance without
introducing a colour system.

Components: local `components/ui/*` in postern's style (`Button`, `Input`, `IconButton`,
`Avatar`), plus cockpit-specific — `StatusDot`, `ResourceRow`, `PlanDiff`, `LogPane`,
`MetricSpark`, `FleetGraph`.

The command palette is load-bearing, not decoration: `⌘K` → "deploy jerry", "logs prod",
"restart db-jerry". For a terminal-first operator it is the cheapest large UX win over
Coolify.

### 2.3 Daemon — `daemon/`

Go. Static single binary, cross-compiled for `linux/amd64` and `linux/arm64`, installable
with one `curl`. No runtime dependency on the box beyond Docker.

- WebSocket client dialling out to `ServerDO`, with reconnect and backoff.
- Executes ops against Docker, UFW, systemd, and cron — a port of `yoke`'s command
  knowledge, transport swapped (ADR-0001).
- Streams container logs and metrics up the existing connection.
- Stateless (#12): holds no database and no desired state.

### 2.4 Install script — `daemon/install.sh`

Served by the plane at `/install.sh`, versioned alongside the daemon, and the only thing
that ever runs directly on a box outside `cockpitd` itself. It is idempotent and safe to
re-run.

1. Detects distro and architecture.
2. Hardens the host — sshd, users, UFW baseline.
3. Installs Docker.
4. Installs the matching `cockpitd` binary and its systemd unit.
5. Enrols: with an embedded token if given one, otherwise prints a claim code.

This replaces the `/devops` `bootstrap-server` playbook. That playbook was prose an agent
interpreted, so three runs produced three subtly different boxes; a versioned script is
identical on every host and can be tested (ADR-0001).

Because it is fetched over HTTPS and piped to a root shell, it is a security-critical
artifact: integrity-verifiable, reproducible from the repo, and templated with nothing but
the plane URL and an enrolment token.

### 2.5 CLI — `apps/cli`

TypeScript on current Node LTS. Published to GitHub Packages, installed globally or run
via `pnpm dlx`. Shares `packages/schema` and `packages/client` with the web app.

**Optional, and off every critical path.** It is an ordinary API client with the same
capability as the UI and the MCP server. It exists because the operator is terminal-first,
and because it is the cheapest early warning that logic has leaked into the web app — a
capability that resists expression as a CLI command usually means a parity break
(ADR-0005). It can ship after v1.

### 2.6 Repo layout

```
cockpit/
  apps/plane/         Worker: Hono API + MCP server + Workflows + Durable Objects
  apps/web/           TanStack Start UI (bundled into the plane Worker)
  apps/cli/           Node CLI — optional API client
  daemon/             Go: cockpitd, plus install.sh
  packages/schema/    Zod: resource kinds, ops, plan/entity types   ← the spine
  packages/client/    Generated typed API client (web + CLI)
  packages/types/     Shared TS types with zero runtime deps
  docs/
```

pnpm workspaces. Makefile as the task entrypoint. Never npm; never run `package.json`
scripts directly.

`packages/schema` is load-bearing: a kind, an op, or an API payload is defined **once**
there, and the REST handler, the MCP tool, the CLI command, and the UI form all derive
from that definition. A capability defined twice is a bug (#2, ADR-0005).

### 2.7 Deliberately not used

Kubernetes, Nomad, Terraform, Ansible; Traefik's file provider (Docker labels instead, so
cockpit owns no proxy config — #17); any ORM-driven admin scaffolding, which is the road
to Coolify's UX.

---

## 3. Flows

### 3.1 Onboard a server

No SSH, and no client on the critical path (ADR-0001). Two directions, same endpoint.

**Pre-authorised — the default.**

```
  1. operator, in UI / CLI / MCP:  POST /servers
                                   → server row (status: enrolling)
                                   + short-lived single-use enrolment token
                                   + a copy-paste one-liner
  2. operator, on the box:         curl -fsSL <plane>/install.sh | sh -s -- --token <tok>
                                   → harden, install Docker, install cockpitd
  3. daemon dials plane, presents the token
                                   → exchanged for a long-lived per-server
                                     credential; the enrolment token is burned
  4. daemon sends `state`          → observed state recorded, server `connected`
```

**Claim code — for boxes that predate cockpit.**

```
  1. operator, on the box:  curl -fsSL <plane>/install.sh | sh
                            → daemon starts unbound, prints a short claim code
  2. daemon dials plane and waits, identified only by that code
  3. operator, in UI / CLI / MCP:  redeem the code
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

### 3.3 Log streaming

```
docker logs -f ──▶ cockpitd ──WSS──▶ ServerDO ──▶ StreamDO ──WS──▶ browser
                                                          └──────▶ MCP / CLI
```

Recent lines live in the `StreamDO`; older lines archive to R2 on a rolling window. One
path, all clients (#1). The `/devops` observability playbook deliberately punted logs;
cockpit cannot.

### 3.4 Observation and drift

The daemon sends a full `state` message on connect and on an interval, plus `event`
messages in real time (container died, health changed, disk pressure). The plane stores
observed state per resource. A scheduled sweep plans every resource against its observed
state; any plan with changes nobody requested is surfaced as **drift** (#7).

### 3.5 An agent operating cockpit

Read side: one call returns a resource with its logs, metrics, recent events, recent
plans, and links — enough to diagnose an outage without fifteen round-trips (ADR-0005).

Write side: the agent proposes a `Plan`. It appears in the UI attributed to that agent,
with its diff and impact. The operator approves in the UI or CLI. The agent cannot mutate
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
- **Secrets are references, never values** (#14). Env values are `op://` refs resolved at
  execution time on the box. No secret value is persisted in D1, in a git snapshot, in a
  log line, or in an API response. This is the `/devops` skill's Rule #2, now enforced by
  types rather than prose.
- **Every mutation is attributable.** Plans and events carry an `Actor`
  (`human | agent | system`).
- **Destructive changes are typed as such** (#15), so the gate cannot be forgotten.
- **The operator's own SSH remains theirs.** It is how they reach their box out-of-band,
  and cockpit neither uses it, stores it, nor needs to know it exists.

---

## 5. Known open questions

Deliberately unresolved; each will get its own ADR when forced.

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
