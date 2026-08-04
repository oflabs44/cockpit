# The Plan is the sole unit of change

Status: accepted

Every mutation of a managed resource, from every client, produces a `Plan`: a typed list
of changes, each carrying `before`, `after`, a declared `inverse`, and an `impact`. Plans
are computed against observed state, approved, then applied. No endpoint mutates a server
without one.

## Why

This one object collapses seven features that platforms normally build, and maintain,
separately:

| feature | how the Plan provides it |
|---|---|
| dry run | a plan is the dry run; applying is a second, explicit act |
| diff review | `before`/`after` per change, renderable in UI, CLI, or a git diff |
| rollback | replay `inverse` in reverse order — no bespoke rollback code |
| audit log | plans are immutable records with an `actor` and timestamps |
| drift detection | plan against observed state; unrequested changes *are* drift |
| agent safety | an agent's output is a proposal, not an effect |
| approval gating | `impact` decides what needs confirmation, and how loudly |

**It decouples "reviewable diff" from "git as storage."** The desire for reviewable
infrastructure changes usually leads to git-as-truth and a reconciler. The Plan delivers
the same property directly, while leaving a database underneath that a UI can be fast
against. See ADR-0004.

**It makes agent access safe enough to be the default.** CONTEXT #3 claims agents and
humans are peers. That claim is only responsible if an agent structurally cannot mutate a
server unilaterally. Proposing a plan is a safe, reversible, reviewable act; applying one
is gated. The peer relationship becomes a property of the type system rather than of the
agent's good behaviour.

**It promotes a prose safety rule into a data field.** The `/devops` skill's Rule #3
required the agent to print an action card — command, target, effect, receipt — before
every operation, and to amplify it for destructive verbs. That worked only as long as the
agent remembered. `impact` is that rule as a field the system cannot skip, and
`before`/`after`/`inverse` are the card's contents, structured.

**It gives an honest activity feed.** "What changed on prod last week, and who did it"
is a query, not an investigation.

## Consequences

- **No side doors, ever.** The moment one convenience endpoint mutates state directly,
  audit, rollback, and drift detection all become quietly untrue. This is the invariant
  most likely to be eroded under delivery pressure and must be enforced in tests: the
  daemon accepts tasks only from an applying plan.
- **Every op must define its inverse**, or explicitly declare itself irreversible (data
  deletion, server destruction). Writing a new op means writing its inverse in the same
  commit.
- **Read/observe operations are not plans.** Fetching logs, metrics, or state, and
  running an interactive exec, mutate nothing cockpit models. They are ordinary API calls
  — logged as events, not planned. The declarative/imperative split must be deliberate;
  blurring it is precisely what makes Coolify's model muddy.
- **A plan can go stale.** Observed state may change between planning and applying. Plans
  record the observed-state revision they were computed against, and apply revalidates;
  a stale plan is rejected and must be recomputed rather than force-applied.
- **Some latency and ceremony.** Trivial changes require plan-then-apply. Mitigated by
  auto-approval policy for `impact: none | reload` where the operator opts in — never for
  `replace` or `destructive`.
- **Partial failure is real.** Apply is a Workflow with one durable step per change. On
  failure mid-plan, the plan is `failed` with per-change status, and the operator (or
  agent) chooses: retry from the failed step, or revert applied steps via their inverses.
