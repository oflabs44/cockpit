# Serverless control plane on Cloudflare, decoupled from managed servers

Status: accepted

The control plane runs on Cloudflare Workers, using D1 for relational state, Durable
Objects for live connections and streams, Workflows for long-running operations, Queues
for fan-out, and R2 for archives. It runs on none of the servers it manages.

## Why

**The control plane must not be hosted on the thing being controlled.** Coolify's model
puts the dashboard, the job queue, and the monitoring on a box that is itself a
deployment target. When that box degrades — which is exactly when the operator needs
visibility — the tool degrades with it. Decoupling is the single most valuable property
here and it is free.

**Always-on, no bootstrap problem.** A self-hosted plane raises "what deploys cockpit?"
Serverless answers it by not asking. No box to provision, harden, monitor, upgrade, or
back up before the platform is usable.

**It matches the operator's existing default.** Personal projects already ship on
Workers (`postern` is the reference implementation for the stack and design language).
No new operational surface, no new hosting bill.

**Reachable from anywhere.** A dashboard and alert receiver that works from a phone,
without a VPN or a tunnel into a private box.

**The primitives fit unusually well.**
- *Workflows* give durable execution: a deploy is one workflow instance, one durable
  step per change, with per-step retry and survival across restarts. This replaces the
  entire background job/queue subsystem a self-hosted platform must build and babysit.
- *Durable Objects* with WebSocket hibernation hold one long-lived daemon connection per
  server, and one log/metric stream per resource, at near-zero idle cost.
- *D1* is more than sufficient: fleet metadata is small, and the write path is
  human-paced.
- *R2* absorbs the unbounded data — log archives, build logs, backup artifacts — that
  should never sit in the relational store.

## Consequences

- **Forces the daemon model.** Workers cannot hold SSH sessions, so ADR-0001 is not an
  independent choice; the two decisions stand or fall together.
- **Builds cannot run in the plane.** CPU and time limits rule it out. v1 therefore
  builds on the target server (CONTEXT #16). A dedicated builder or laptop-plus-registry
  is a later option, but the plane will never be the builder.
- **Cloudflare is a hard dependency.** The plane is not portable, and this is accepted
  rather than abstracted: unlike `postern`'s core, there is no platform-independent
  logic here worth a seam. Workflows and Durable Objects have no neutral equivalent and
  pretending otherwise would buy an abstraction validated by one implementation.
- **State lives with a third party.** Fleet configuration — not secrets, which remain
  secret refs (CONTEXT #15) — sits in D1. The git mirror (ADR-0004) is the mitigation:
  a full config history the operator holds independently.
- **Request-scoped runtime discipline.** No in-memory caches or singletons that assume a
  long-lived process. Anything long-lived is a Durable Object or a Workflow, explicitly.
- **The daemon connection is a Durable Object concern**, one per server, which makes
  "is this server connected" a naturally consistent question rather than a distributed
  one.
