# Strict client parity: web UI, CLI, and MCP over one API

Status: accepted

cockpit exposes exactly one API. The web UI, the `cockpit` CLI, and the MCP server are
clients of it, with identical capability. No client may do anything the others cannot,
and no client may contain business logic.

## Why

**This is the product thesis, not an implementation detail.** "Agentic-first" is
otherwise just a chat box bolted to a dashboard. Parity is what makes an AI agent a peer
of the human operator rather than a second-class consumer of whatever endpoints happened
to get built.

**Coolify demonstrates the failure mode.** Its API is an afterthought grown alongside a
UI-shaped application, and significant parts of what the UI does have no API path at all.
An agent driving it is permanently working around gaps. That asymmetry is impossible to
retrofit away and cheap to prevent — it costs nothing at line one and enormously at line
100,000.

**Parity is only real if it is enforced, not intended.** The mechanism is a single Zod
schema set in `packages/schema`: every operation is defined once, and the REST route
handler, the MCP tool definition, the CLI command, and the UI form all derive from that
definition. Adding an operation makes it appear in all three clients or in none.

**The CLI is optional, and that is the point.** An earlier draft argued the CLI was
structurally required because onboarding needed SSH from the operator's laptop. That was
wrong — onboarding is an install script the operator runs on the box (ADR-0001), so no
client is on the critical path. The CLI therefore exists for two honest reasons: it is the
human-facing peer of the MCP client, and it suits a terminal-first operator who would
rather type a command than open a dashboard.

It also serves as the **parity canary**. A capability that is awkward or impossible to
express as a CLI command is usually a capability that leaked logic into the web app. The
CLI is where that gets noticed early and cheaply.

## The enforceable rule

If a client computes, validates, orders, or decides anything, that is a bug.

Clients render, dispatch, and display. Concretely, this forbids: validation that exists
only in the UI form; ordering of deploy steps decided in the CLI; a "restart after env
change" rule implemented in a React component; MCP tools that compose several API calls
to achieve something the API cannot do in one.

Where such logic is discovered, the fix is always to move it below the API, never to
duplicate it into the other clients.

## Consequences

- **A UI feature is never "just a UI feature."** Every capability starts as a schema and
  an API operation. This is slower per feature and is the intended trade.
- **No SSR-only logic.** The web app may server-render for performance, but nothing it
  renders may depend on logic unreachable by the other clients.
- **The MCP tool surface is generated, not hand-curated.** Tools derive from the same
  schemas. Ergonomic groupings for agents are allowed as read-side conveniences (for
  example, one call returning logs, metrics, recent changes, and links for a resource) —
  but never as a write path that composes what the API cannot express.
- **Three clients to keep working.** Mitigated by the fact that two of them
  (`packages/client` consumers: web and CLI) share a generated typed client, and the
  third derives from the same schemas.
- **CLI distribution follows Node.** The CLI is TypeScript on current Node LTS, published
  to GitHub Packages and installed globally or run via `pnpm dlx`. It shares
  `packages/schema` and `packages/client` with the web app, which is the point — a
  separate Go CLI would mean two type worlds for no gain, since the CLI runs on the
  operator's laptop rather than on a small box. Being off the onboarding path, it has no
  bootstrapping constraint and need not be a single self-contained binary.
- **The CLI can ship after v1** without blocking anything, since neither onboarding nor
  any other flow depends on it.
- **Auth differs per client and must not fork behaviour.** The UI sits behind Cloudflare
  Access; MCP uses OAuth; the CLI uses a device-flow token. Three authentication paths,
  one authorisation model.
