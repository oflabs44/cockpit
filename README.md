# cockpit

A personal cloud deployment platform for private VPSes you own. Provision, deploy,
observe, operate — from a web UI or from an AI agent over MCP, with identical
capability from both.

**Status: design locked, not yet built.**

## The shape

- **Control plane** on Cloudflare Workers — runs on none of the servers it manages, so it
  survives their failure.
- **`cockpitd`**, a Go daemon on each server, dialling **out** over WSS. cockpit never
  uses SSH: onboarding is a one-line install script you run on the box.
- **Changes to desired state are `Plan`s** — typed, diffable, with a declared inverse and
  an impact level. Propose, review, apply. Rollback, audit, drift detection, and agent
  safety all fall out of that one object. Operations that leave the spec identical —
  restart, exec, logs — are direct and recorded as events.
- **AI-first means peer access**, not a chat box: an agent over MCP and a human in the UI
  are peers on the same API, and every agent action lands in the UI attributed to it.

## Documents

| document | what it is |
|---|---|
| [`CONTEXT.md`](./CONTEXT.md) | Glossary and the numbered decision log. **Wins on meaning.** |
| [`docs/architecture.md`](./docs/architecture.md) | Topology, stack, flows, security model, open questions |
| [`docs/type-design.md`](./docs/type-design.md) | The buildable spec: entities, protocol, API, invariants |
| [`docs/design.md`](./docs/design.md) | The design system, derived from the prototype |
| [`docs/development.md`](./docs/development.md) | Dogfooding on a real box: two planes, three tiers, the loop |
| [`docs/prototype-reality-check.md`](./docs/prototype-reality-check.md) | Every rendered value traced to what produces it |
| [`docs/adr/`](./docs/adr/) | Rationale for the load-bearing decisions |
| [`docs/kickoff-foundation.md`](./docs/kickoff-foundation.md) | Prompt to start the first build session |

## Decisions

| | |
|---|---|
| [ADR-0001](./docs/adr/0001-daemon-only-execution-no-ssh.md) | The daemon is the only execution path; cockpit never uses SSH |
| [ADR-0002](./docs/adr/0002-serverless-control-plane-on-cloudflare.md) | Serverless control plane on Cloudflare, decoupled from managed servers |
| [ADR-0003](./docs/adr/0003-plan-as-sole-unit-of-change.md) | The Plan is the sole unit of change |
| [ADR-0004](./docs/adr/0004-d1-as-truth-git-as-mirror.md) | D1 is the truth; git is an export mirror |
| [ADR-0005](./docs/adr/0005-strict-client-parity.md) | Strict client parity: every client over one API |
| [ADR-0006](./docs/adr/0006-polymorphic-resource-model.md) | One polymorphic Resource entity, with Links as first-class relationships |
| [ADR-0007](./docs/adr/0007-resource-scope-server-or-account.md) | Every kind declares its scope: server or account |
| [ADR-0008](./docs/adr/0008-secrets-resolved-on-the-box.md) | Secrets are resolved on the box, by the daemon |

## Lineage

cockpit replaces three things in one stack: **Coolify** (which remembered what was
deployed, clunkily), the **`yoke` CLI** (which executed well but deliberately remembered
nothing), and the **`/devops` playbooks** (~17 procedures written in English, which three
agents would follow three different ways). yoke's command knowledge is ported into the
daemon; the playbooks become typed, tested operations.
