# Kickoff prompt — foundation (schema, plane skeleton, daemon handshake)

Paste the block below into a fresh session to start building. It is self-contained but
leans on the design docs as the source of truth (`CONTEXT.md`, `docs/architecture.md`,
`docs/type-design.md`, `docs/adr/*`).

Tooling choices are already baked into the docs (pnpm workspaces, Makefile task runner,
Vitest, Cloudflare Workers, Go daemon). The "wait for my OK before scaffolding" line keeps
a human checkpoint at the layout step — drop it to let the session run autonomously.

---

```
Project: cockpit — a personal cloud deployment platform for private VPSes. Control
plane on Cloudflare Workers, a Go daemon on each managed server, and strict
capability parity across the web UI and MCP. We're starting the build. The design
is locked — do NOT re-litigate it; if you hit a real gap, surface it before deviating.

READ FIRST (in this order), then confirm you've internalized them:
- CONTEXT.md              — 19 locked decisions + glossary + conventions (this wins)
- docs/architecture.md    — topology, stack, flows, security model, open questions
- docs/type-design.md     — the buildable spec: entities, specs per kind, Plan/Change,
                            daemon protocol, API surface, invariants to test
- docs/adr/0001..0008     — rationale for the load-bearing decisions

THE FOUR RULES THAT MATTER MOST (violating these is a design bug, not a style nit):
1. One API, two clients, zero capability gap. No business logic above the API. (#1, #2)
2. Every mutation is a Plan. No endpoint mutates a server directly. (#6, ADR-0003)
3. Plans diff against OBSERVED state reported by the daemon, never last-known. (#7)
4. Secrets are refs (op://...), never values, and are resolved by the DAEMON on
   the box -- never by the plane. (#15, ADR-0008)

SCOPE FOR THIS SESSION — the spine only. No deploys, no builds, no UI polish:

1. Scaffold a pnpm-workspace monorepo with a Makefile task runner (never npm; never
   run package.json scripts directly). TypeScript strict. Vitest. Layout per
   docs/architecture.md §2.5. WAIT FOR MY OK before scaffolding.

2. packages/schema — the spine. Zod 4 schemas for: primitives (Id, Actor, SecretRef,
   Health, Changed), Server, Enrolment, Resource, Observed, Plan/Change/Op/Impact,
   Release, Link, Event. AppSpec and DatabaseSpec only; the other kinds are stubs
   registered in the kind registry but not implemented. Types inferred, never
   hand-written alongside.

3. packages/schema — the kind registry. A kind = { specSchema, observedSchema,
   planner, daemonOpName }. Adding a kind must touch exactly this registry plus a
   daemon handler, nothing else (ADR-0006). Prove it with a test.

4. apps/plane — Worker skeleton: Hono, Drizzle + D1 migrations for every entity,
   ServerDO holding the daemon WebSocket, and these routes only:
   GET /install.sh, POST /servers, GET /servers, GET /servers/:id,
   GET /enrolments, POST /enrolments/:code/redeem, WS /daemon.
   Clock and id generation injected — no Date.now(), no Math.random().

5. The enrolment handshake, both directions (docs/architecture.md §3.1):
   token mode and claim-code mode. Single-use, expiring, hashed at rest, rate-limited
   for claim codes. Unenrolled connections may do nothing but enrol.

6. daemon/ — Go: dial out over WSS, hello/auth, send a `state` snapshot of observed
   Docker containers, reconnect with backoff. Executes NOTHING yet — observation and
   handshake only. Plus install.sh doing: detect distro/arch, harden, install Docker,
   install cockpitd + systemd unit, enrol. Idempotent and re-runnable.

7. The planner core: given desired specs + observed state, produce a Plan with
   per-change before/after/inverse/impact and a `basis` of observed revisions. Apply
   is NOT in scope this session — planning only.

8. Tests for invariants 1-5, 10, 11, 13, 14 from docs/type-design.md §5. The parity
   test (7) can be a stub that fails loudly once write ops exist.

OUT OF SCOPE (do not start): applying plans, Workflows, deploying anything, builds,
log/metric streaming, R2, the git mirror, the MCP server, the web UI beyond
whatever is needed to prove a server enrols, backups, alerts, provisioning.
```

---

## Sessions after this one

Roughly in dependency order. Each is a session-sized slice.

1. **Apply** — Workflows, one durable step per change, `task` frames to the daemon, per-
   change status, failure and revert paths, `Release` on success.
2. **Deploy an app end-to-end** — `AppSpec` handler in the daemon: clone, build on the
   box under limits, run with Traefik labels, healthcheck poll. Plus build-log streaming.
3. **Streams** — `StreamDO`, live logs and metrics, R2 archival.
4. **Web UI** — fleet view, resource detail, plan review, activity feed, `⌘K` palette.
5. **MCP server** — tools generated from the schema, plus the grouped read tool.
6. **Databases** — `DatabaseSpec`, credential generation into the vault, private network,
   and the `uses` link with env injection.
7. **Drift sweep, health monitoring, alerts.**
8. **Backups and tested restore** — the largest inherited gap; needs its own ADR first.

## The thinnest end-to-end proof

Sessions 1-4 together deliver the slice worth aiming at: **onboard a box, deploy one app
from a repo, see it live over TLS, watch its logs, roll it back.** That single path
exercises Server, Enrolment, Resource, Plan, Release, Event, the daemon protocol,
Workflows, streaming, and two clients. Everything after it is filling in kinds.
