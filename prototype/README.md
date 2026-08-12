# Prototype status

These files remain the visual reference for Cockpit's paper-and-ink design system.

They predate [ADR-0009](../docs/adr/0009-deployments-record-changes-without-a-review-gate.md).
Many screens still show the removed global Plans flow and mandatory approval. Those parts
are archived and must not guide implementation.

Current domain rules:

- A project can contain multiple apps.
- Each app deploys independently.
- Project pages own deployment navigation.
- A push to a configured branch continues automatically.
- Calculated changes appear inside deployment logs.
- The global rail has no Plans or Deployments destination.

Use [`CONTEXT.md`](../CONTEXT.md) and [`docs/type-design.md`](../docs/type-design.md) for the
current model. Regenerate the affected prototypes before using them for deployment UI work.
