# The Plan is the unit of change to desired state

Status: accepted (amended — direct operations carved out)

A `Plan` is required whenever **desired state** changes: a typed list of changes, each
carrying `before`, `after`, a declared `inverse`, and an `impact`, computed against
observed state, approved, then applied.

Operations that do **not** alter desired state — restart, stop, start, exec, tail logs,
run a one-off command, open a terminal — are **direct**. They execute immediately and are
recorded as `Event`s with an actor. They are not plans, and requiring them to be one was
over-strict.

The test is a single question: **after this, does the spec say something different?**
Restarting `jerry` leaves the spec identical — same image, same env, same replica count —
so it is an operation. Setting `LOG_LEVEL=debug` changes what `jerry` *is*, so it is a
plan.

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

## Why it is not every mutation

The original rule said every mutation, full stop. That is over-broad, and the cost is not
merely friction — it is that **approval fatigue destroys approval**. If restarting a
container produces a diff and a confirmation, the operator learns to click through
confirmations, and the click-through habit is exactly what carries them past the plan that
destroys a volume. A gate that fires on everything protects nothing.

The carve-out is narrow and testable. Direct operations may not change the spec, so they
cannot silently redefine what a resource is; anything that would is still a plan. And
`impact: destructive` still requires explicit confirmation whether it arrives as a plan or
as an operation — deleting data is never a "direct operation" on the grounds that it left
the spec alone.

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

- **Two write paths, both attributable.** The daemon accepts `task` frames bound to an
  applying plan, and `op` frames bound to a recorded event. It accepts nothing else. The
  invariant is no longer "only plans mutate" but "nothing mutates unattributably", which is
  the property that actually mattered.
- **Operations manufacture drift, and that is now expected rather than exceptional.** A
  restart is harmless, but an exec or a terminal session can leave the box diverged from
  its spec. Every operation therefore forces a state re-sync on completion, so the
  divergence is detected immediately rather than discovered by the next planner run. This
  is the strongest argument for surfacing drift in the UI, which was deferred.
- **Every op must define its inverse**, or explicitly declare itself irreversible (data
  deletion, server destruction). Writing a new op means writing its inverse in the same
  commit.
- **The declarative/imperative split must stay deliberate.** Blurring it is what makes
  Coolify's model muddy. The line is drawn at desired state and nowhere else — not at
  "risky", not at "slow", not at "the operator would find this annoying", each of which
  would drift under pressure until everything was an operation.
- **A plan can go stale.** Observed state may change between planning and applying. Plans
  record the observed-state revision they were computed against, and apply revalidates;
  a stale plan is rejected and must be recomputed rather than force-applied.
- **Latency is now confined to real changes.** Spec edits still cost plan-then-apply,
  which is the point. Auto-approval policy for `impact: none | reload` remains available
  where the operator opts in — never for `replace` or `destructive`.
- **Partial failure is real.** Apply is a Workflow with one durable step per change. On
  failure mid-plan, the plan is `failed` with per-change status, and the operator (or
  agent) chooses: retry from the failed step, or revert applied steps via their inverses.
