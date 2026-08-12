# Deployments record changes without a review gate

Status: accepted

Supersedes [ADR-0003](./0003-plan-as-sole-unit-of-change.md).

An application change runs as a `Deployment`. A deployment belongs to one app resource,
lives inside that resource's project, and records its source revision, configuration
snapshot, steps, logs, calculated changes, outcome, and resulting release.

The calculated change set is a deployment step. It is evidence of what Cockpit is about
to do and what it did. It is not a separate proposal, queue item, or mandatory approval
gate.

A push to a configured deployment branch is already an authorized trigger. Cockpit must
not stop that pipeline for a second approval. A manual Deploy action is also authorization
to continue. Cockpit can reject an invalid or unsafe request before execution, but it does
not turn every valid request into a waiting Plan.

## Context

ADR-0003 treated a Plan as the sole unit of desired-state change. That model optimized for
review before execution. It did not match continuous deployment:

```text
push to main -> build -> wait for approval -> apply
```

The extra wait breaks the operator's expectation that an authorized push runs through the
pipeline. It also places a project concern in a global review queue.

The useful part of the old model remains: Cockpit still calculates `before`, `after`, and
`impact` against observed state. It now stores that data on the deployment, beside the
build and apply logs where an operator investigates a failure.

## Decision

### Ownership

A project groups resources on one server. It can contain multiple app resources, and each
app deploys independently. A deployment belongs to one app resource. The project view
aggregates deployments from its apps.

Deployments never appear as a global navigation destination.

### Configuration and running state

Saving app configuration does not change the server. The saved configuration is input to
the next deployment. Starting a deployment takes an immutable configuration snapshot, so
later edits cannot alter a running deployment.

The current release defines the intended running state. The daemon's report defines the
observed state. Drift is the difference between those two states. Saved but unapplied
configuration is not drift.

### Pipeline

A source webhook for a configured branch starts a deployment automatically. Cockpit builds
on the target server, as specified by decision #17. The normal pipeline is:

```text
queued -> fetching -> building -> planning -> deploying -> checking
       -> succeeded | failed | cancelled
```

`planning` calculates and records the change set after the build resolves the image
digest. Apply continues without a review gate.

A manual deployment, redeploy, or rollback uses the same pipeline. Rollback deploys a
previous release snapshot. It does not replay a stored inverse.

### Other resource changes

A non-app resource change runs as an `Operation`. An operation records its actor, target,
configuration snapshot, calculated changes, logs, and outcome. A successful configuration
apply creates a resource release.

Immediate commands such as restart, stop, start, and exec are also attributable operations.
They do not create releases because they do not change resource configuration.

Destructive actions use separate, explicit endpoints with confirmation at request time.
They do not enter a general approval queue.

### Agent access

Agents and humans use the same API. Authorization controls which triggers and destructive
actions an actor can invoke. Attribution, immutable snapshots, deployment logs, changes,
releases, and events provide the audit boundary. A mandatory human approval is not the
agent safety boundary.

## Consequences

- The `Plan` entity and its pending, approved, and rejected lifecycle are removed.
- The global Plans page and pending-plan badge are removed.
- `Change` remains a recorded fact inside a deployment or operation.
- `impact` remains data for diagnosis and destructive-action validation. It does not create
  a normal deployment gate.
- Releases, not editable configuration, define intended running state.
- Drift compares a current release with observed state.
- A project deployment page aggregates its independently deployable apps.
- The daemon accepts mutation frames only when they reference a persisted deployment or
  operation. Nothing mutates without attribution.
