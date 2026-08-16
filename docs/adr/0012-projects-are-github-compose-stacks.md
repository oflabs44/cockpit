# Projects are GitHub-backed Docker Compose stacks

Status: accepted

A Cockpit Project is one deployable Docker Compose stack on one server. It binds a
connected GitHub Source, repository, ref, base directory, and Compose path. The repository's
standard Compose file defines the workload topology; Cockpit does not maintain a second,
editable app or service configuration.

This amends `docs/architecture.md` §§2.7 and 3.2 and `docs/type-design.md` §§2.2–2.9.

## Decision

One repository and Compose path equals one Project. A monorepo can create several Projects
by selecting different base directories or Compose files. The Project, not an individual
service, is the deployment and release boundary. Compose services are derived, read-only
resources; containers are observed runtime instances.

The repository remains portable standard Compose. `x-cockpit` is not required. The Plane
stores only environment-specific deployment settings:

- the ingress service, internal port, and domains;
- an optional migration service and command override;
- services required to become healthy;
- plain variable bindings and secret references.

The Plane generates a standard `cockpit.override.yaml` for release image names,
`cockpit.*` ownership labels, Traefik labels, and the shared ingress network. The daemon
normalizes the repository file and generated override together with `docker compose config`,
validates the effective model, and executes it. The original file is never rewritten.

Every executable Project workload is a container. Networks and volumes are Docker-managed
primitives. Traefik is one shared, server-scoped container stack and is the only workload
that publishes host ports 80 and 443. Docker and `cockpitd` remain the unavoidable host
footprint; Project deployment never installs language runtimes, databases, proxies, cron
jobs, or application services directly on the host.

## Deployment

A deployment snapshots an exact Git commit and the Project's Plane-owned settings, then runs:

```text
fetch -> normalize and validate -> build -> migrate -> compose up -> health -> release
```

Buildable services receive immutable release image names before apply. The migration service
runs as a one-shot container and must succeed. `docker compose up` applies the effective
model without `--build`; builds finish before a running container changes. Named volumes are
never removed by deployment or rollback.

The first implementation uses one stable Compose project name per Cockpit Project and accepts
brief replacement downtime. Blue/green release stacks are a later optimization, not a second
execution path.

A Release records the source revision, effective Compose snapshot, image identities, and
runtime snapshot for the whole Project. Rollback reapplies an earlier release's Compose and
images; it never attempts to reverse database migrations or restore volume data.

## Plane and daemon boundary

A Cloudflare Workflow owns each durable deployment. `ServerDO` owns the live daemon socket.
The Workflow sends prepare/apply commands through `ServerDO` and waits for correlated daemon
events. Build and runtime logs use the stream path rather than Workflow state.

The daemon fetches and builds on the target server. GitHub installation tokens are short-lived
and may pass to the daemon for one fetch, but are never stored or logged. Secret references
remain references in the Plane and release snapshot; the daemon resolves values immediately
before Compose execution.

## Initial Compose policy

The first version supports services, images and builds, commands, health checks, internal
networks, named volumes, dependencies, profiles, restart policies, and resource limits. It
rejects privileged containers, Docker socket mounts, host PID/IPC/UTS/network, user
namespace sharing, cgroup and `cgroup_parent` selection, device cgroup rules, security
options, `volumes_from`, devices, arbitrary bind mounts, explicit container names, direct
host port publishing, external volumes, volume driver options, external configs and secrets,
and unapproved external networks. An approved external network is matched by the network's
own name, never by the document key the repository chose for it.

The policy is an explicit deny-list, not deny-by-default: a Compose field it does not name
runs unchanged, so tightening the policy means adding to that list.

Repository-controlled Compose files, build contexts, Dockerfiles, env files, configs,
secrets, includes, and external `extends.file` references must not resolve outside the
checked-out commit, including through symlinks. Inputs that Compose itself would read must be
checked before normalization or normalized inside a filesystem sandbox. Other policy failures
happen before build or apply.

Implementation status: the paths the effective model names — Compose files, build contexts,
Dockerfiles, env files, config and secret files — are checked against the checkout, with
symlinks resolved on disk. `include` and `extends.file` are **not** yet contained: Docker
resolves them while producing the effective model, so a check on the model is already too
late, and the sandbox that has to run normalization under is deferred to the fetch slice
that creates the checkout. Until it exists, this requirement is stated, not met.

## Consequences

- Existing app-resource deployment routes and resource-scoped releases are superseded by
  Project-scoped deployments and releases.
- GitHub import becomes the Project creation flow. Manual service CRUD is not desired-state
  authoring for imported Projects.
- A push to the configured ref can start the same Project deployment as the manual action.
- The effective release model has two explicit owners: Git defines workload topology; the
  Plane defines target-specific bindings and generates a visible, reproducible override.
- Cockpit does not need framework detection. Laravel, workers, schedulers, PostgreSQL, and
  Redis are ordinary Compose services.
