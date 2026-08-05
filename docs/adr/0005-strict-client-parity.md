# Strict client parity: every client over one API

Status: accepted (amended — CLI deferred)

cockpit exposes exactly one API. The web UI and the MCP server are clients of it, with
identical capability. No client may do anything the other cannot, and no client may
contain business logic. Any client added later — a CLI, a TUI, a phone app — is a third
consumer of the same API and must not require a single new endpoint.

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
handler, the MCP tool definition, and the UI form all derive from that definition. Adding
an operation makes it appear in every client or in none.

**The CLI is deferred, not rejected.** Two earlier drafts got this wrong in opposite
directions. The first made it structurally required, because onboarding needed SSH from
the operator's laptop — wrong, since onboarding is an install script the operator runs on
the box (ADR-0001). The second kept it as an optional third client. It is now dropped
from v1 entirely: nothing depends on it, and two clients are enough to prove the rule.

The cost of dropping it is real and worth naming. The CLI was the **parity canary** — a
capability awkward to express as a command usually means logic leaked into the web app,
and a human typing commands notices that faster than a test does. Without it, the only
guard is mechanical (see Consequences), so that test stops being a nice-to-have.

Adding a CLI later must therefore require **zero new endpoints**. If it ever does, the
parity rule was already broken and the CLI merely revealed it.

## The enforceable rule

If a client computes, validates, orders, or decides anything, that is a bug.

Clients render, dispatch, and display. Concretely, this forbids: validation that exists
only in the UI form; a "restart after env change" rule implemented in a React component;
ordering of deploy steps decided client-side; MCP tools that compose several API calls to
achieve something the API cannot do in one.

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
- **The parity test is now the only guard, so it is not optional.** For every write
  operation in `packages/schema`, assert that a REST route and an MCP tool exist and are
  generated from the same definition (`type-design.md §5.7`). With no CLI to notice a
  break by feel, a red test is the sole warning.
- **`packages/client` still earns its place**, even with one consumer. It is where the
  typed API surface lives, and it is what a CLI would import unchanged on the day it
  appears.
- **When a CLI does arrive it is TypeScript on current Node LTS**, sharing `packages/schema`
  and `packages/client` with the web app — a separate Go CLI would mean two type worlds for
  no gain, since it runs on a laptop rather than a small box.
- **Auth differs per client and must not fork behaviour.** The UI sits behind Cloudflare
  Access; MCP uses OAuth. Two authentication paths, one authorisation model — and a third
  added later must slot into the same model rather than bring its own.
