# cockpitd

The on-box agent. This build **enrols, connects, observes, and executes docker
app changes**: the full state snapshot — host, containers, firewall rules,
systemd units, cron — plus `task` and `op` frames against the app kind. No
builds, no secret resolution, no ufw/systemd/cron execution, no streams, no
metrics, no `install.sh`.

## Run it

```sh
make build
./bin/cockpitd --foreground --plane https://cockpit-dev.workers.dev --token ck_enrol_8fkq2t
```

Once enrolled the token is burned and the credential is persisted, so later
runs need only `--plane` (or nothing at all, since the plane URL is stored too).

Without a token, and with no credential yet, the daemon takes the claim-code
direction (architecture section 3.1): it prints a code, presents it to the
plane, and waits to be bound.

```sh
./bin/cockpitd --foreground --plane https://cockpit-dev.workers.dev
```

```
cockpit

  cockpitd is installed and running on lab-nbg1.
  This server is not yet bound to a plane.

  Claim code   4F2K-9TQX
  Plane        https://cockpit-dev.workers.dev

  Redeem the code in your cockpit client to bind this server.
  It expires in 10 minutes; a new one is printed here when it does.
```

The block goes to stdout, not the log: it is what an operator reads seconds
after `install.sh` finishes. It is re-printed on every reconnect while still
unclaimed, and a fresh code is generated and printed when the previous one
ages out. A dropped connection does **not** invalidate the code on screen —
only its own deadline does. Until the bind completes the daemon sends nothing
but `hello` and `awaiting_claim`.

Codes are `XXXX-XXXX` over a 24-character alphabet with the confusables
removed (no `0/O`, `1/I/L`, `U/V`, `5/S`, `8/B`, `2/Z`), so they survive being
read off a terminal and typed into a form, or read aloud.

| flag | meaning |
|---|---|
| `--foreground` | log to stdout as text rather than JSON; `Ctrl-C` to stop |
| `--plane <url>` | plane base URL; `http(s)` and `ws(s)` both accepted, `/daemon` is appended |
| `--token <tok>` | enrolment token, presented once by a daemon holding no credential; omit it to use the claim-code flow |
| `--config <path>` | config file; defaults to `/etc/cockpitd/config.json` as root, `$XDG_CONFIG_HOME/cockpitd/config.json` otherwise |

`make test` runs everything with no network and no Docker (tier 1).
`make push BOX=lab-nbg1 ARCH=arm64` cross-compiles and copies the binary to the
scratch box over **your** SSH, which is not cockpit's SSH (ADR-0001).

## Shape

```
cmd/cockpitd          flags, wiring, signals
internal/protocol     frame types, verbatim from docs/type-design.md section 3
internal/client       dial, handshake, snapshot, serve, reconnect with backoff
internal/observer     executors -> state snapshot; reports, never mutates
internal/ops          ensure-semantics docker ops; the only code that mutates
internal/executor     Docker, Host, Firewall, Systemd, Cron interfaces
  /dockercli          Docker over the docker CLI
  /oscli              host, ufw, systemd and cron over /proc, /etc and the CLIs
  /fake               in-memory executors for tier 1 tests
internal/config       the plane URL, server id, and credential; nothing about the box
```

The dial carries `Authorization: Bearer <secret>` — the credential, the
enrolment token, or the claim code, whichever applies — because the plane
resolves which daemon this is from the upgrade request before choosing a
Durable Object. The same secret still goes in `hello.auth`; the plane checks
both. Prefixes (`ck_cred_`, `ck_enrol_`) come from the plane and the operator
and are passed through untouched; an unprefixed secret is read as a claim code,
which is what a generated `XXXX-XXXX` already is.

Plane refusals are logged by name rather than as a bare dial failure: HTTP 429
(rate limited) and 409 (another socket already holds this claim, so the code is
*kept*) back off and retry; close 4006 (lost a token race) retries with the same
token; close 4007 (claim no longer pending) regenerates and reprints the code.

Two thresholds are hardcoded rather than configurable: a claim code lives 10
minutes from generation (wall clock, not per connection), and three consecutive
failed snapshots end the session, so a box the daemon can no longer observe
stops looking connected instead of leaving a stale snapshot standing as current.

A credential the plane issues is held in memory and written to disk before
anything else; if that write fails the session continues on the in-memory
credential, the secret that produced it is *not* burned, and the write is
retried at the start of every session. The failure logs at Error, because a
restart before it lands orphans the box — the plane has already burned the
enrolment secret.

## What it observes

The snapshot is the operator's old `inspect-server` playbook, compiled. Probes
A–F of that markdown become typed observers; the thresholds it carried
(disk >= 80%, cert < 14 days, `PermitRootLogin yes` is red) do **not** come with
them — those are plane policy. The daemon reports raw facts only.

- **host** — `identity` (os, kernel, hostname, uptime), `capacity` (cpus, mem,
  swap, disks with tmpfs/overlay filtered out), `load`, `listeners`, and
  `security` (sshd's effective flags, fail2ban and unattended-upgrades active,
  `last_apt_activity_unix` — the mtime of apt's history log, which is any apt
  activity, not specifically an upgrade).
- **app** — containers, now with `started_at`, `restart_count`,
  `restart_policy`, `image_id` (the local image) and `image_digest` (the
  registry digest, empty for an image built on the box) from one `docker
  inspect` per snapshot.
- **firewall_rule** — parsed from `ufw status verbose`, v6 duplicates dropped.
  Named `<port>-<protocol>-<action>-<source>` (`22-tcp-allow-any`,
  `9100-tcp-deny-any`), so rules differing only by source or by allow/deny are
  separate resources rather than one that flickers. `Anywhere` normalises to
  `any`.
- **daemon** — systemd units, scoped to `cockpit-*`, docker, ssh/sshd, fail2ban
  and unattended-upgrades. Not all 300 units on a box. A second
  `list-unit-files` pass covers units systemd knows but has not loaded — masked,
  disabled, never started — so a hard-stopped unit reports inactive instead of
  vanishing.
- **cron** — root's crontab.

Docker is the one hard dependency: a daemon that cannot see containers is not
observing anything useful. Every other probe is soft — a box without ufw, a
container without systemd, a Mac in development — and yields zero values with a
debug line rather than failing the snapshot. Parsers skip malformed lines with a
warning and keep going.

Soft failure is reported, not hidden: the state frame carries
`probes: {docker|firewall|systemd|cron|host: ok|unavailable}`. A probe that ran
and found nothing is `ok`; one whose command is missing or errored is
`unavailable`, so a transient ufw failure cannot read to the planner as every
firewall rule having been deleted.

All five executors — `Docker`, `Host`, `Firewall`, `Systemd`, `Cron` — are
implemented and faked. `executor.Set` is the whole seam the tier-1 tests replace,
so every parser is tested against captured `ufw`, `ss`, `sshd -T`, `systemctl`,
`crontab`, `df` and `/proc` output in `internal/executor/oscli/testdata` with none
of those binaries present.

Docker is read through the `docker` CLI rather than the Go client library: the
daemon is a static single binary with no runtime dependency on the box beyond
Docker itself, the CLI is guaranteed present wherever Docker is, and `docker ps
--format '{{json .}}'` is a stable contract. The client library would pull in a
large dependency tree and an API-version negotiation problem for one read.
`ParsePS` is a pure function, so the parsing is tested without Docker present.

## What it executes

Two write frames and nothing else (type-design section 3.3):

- **`task`** — a plan's changes, run in order, one `task_progress` pair
  (`started`, then `ok`/`error`) per change. It stops at the first failure: the
  plane owns retry and revert, every op is idempotent so a re-sent task is
  safe, and continuing would apply later changes against a box that is no
  longer what the plan was computed for.
- **`op`** — one direct `restart`/`stop`/`start`, answered with an `op_result`
  for every outcome: executed, failed, or refused. A frame carrying `spec`,
  `after`, `before`, `changes` or `plan_id` is refused: an op leaves the spec
  identical by definition, and that refusal is what keeps the carve-out from
  being a loophole. A frame naming no `op_id`/`event_id` is dropped in silence —
  it is bound to no Event, so there is nothing to answer.

Refusals answer. A task the daemon will not run (no `task_id`/`plan_id`, no
executor wired) gets a `task_progress` `{status: error, error: {kind: refused}}`
at change index 0, because a plan sitting in `applying` must never hang on the
daemon's silence.

Both force a fresh state snapshot on completion, so the plane sees what is
actually on the box rather than inferring it from the changes.

Every op has ensure-semantics and reports `create | in_place | replace | no_op`.
The container carries a `cockpit.spec` label holding a hash of the spec it was
created from — that label, on the box, is how "is this already what the plan
asks for" is answered without the daemon holding any desired state (#13). Run
any op twice and the second is `no_op`; every op has a test that proves it.

The one exception is `restart`, which reports `in_place` every time: asking for
two restarts means two restarts, and reporting the second as `no_op` would be a
lie about what happened to the box.

## Protocol notes

Two gaps against `docs/type-design.md` section 3, resolved here provisionally.
Both need confirming with the plane implementor.

1. **There is no plane -> daemon frame for the enrolment answer.** Section 3.2
   lists `task`, `op`, `stream`, `probe`, `exec`, `ping` — nothing acknowledges
   a `hello` or delivers the long-lived credential the daemon is supposed to be
   issued (section 3.3). This build expects
   `{ type: 'welcome', server_id, credential? }` as the first frame after
   `hello`, with `credential` present only when the `hello` carried an
   enrolment secret. Until it arrives the connection sends nothing further,
   which is how "an unenrolled connection may do nothing but enrol" is
   enforced daemon-side.

2. **`ObservedResource.kind` for an arbitrary container is undecided.** A
   container the daemon did not create has no cockpit identity. This build
   reports the `cockpit.kind` label when present and `app` otherwise, keyed by
   container name. Whether unmanaged containers should be reported at all —
   and how the plane matches an observed name to a `Resource` — is the plane's
   call, and the answer may change `kindOf`.

3. **`awaiting_claim` and `hello.auth` overlap, and the spec does not say how.**
   `hello.auth` is not optional in section 3.1, but a claiming daemon holds no
   secret to put in it — while section 2.1.1 says both directions "converge on
   the same exchange: the daemon presents a secret". This build sends `hello`
   with `auth: { kind: 'enrolment', secret: <claim code> }` and then
   `awaiting_claim` with the same code, so the plane may authenticate off
   either. The alternatives are a third `auth.kind` (`'claim'`), or an optional
   `auth` with `awaiting_claim` as the sole identification. The plane's
   validator decides; this is one line in `handshake`.

   Related: the plane's answer to a redeemed claim is assumed to be the same
   `welcome` frame as (1), carrying `server_id` and `credential`. Nothing in the
   spec says how a daemon learns it was bound, and it may be a long wait —
   minutes of an idle connection — so whether the plane pings during it, and
   whether a rejected or expired code gets an explicit refusal frame rather
   than a silent close, are both open. This build treats silence to the code's
   own deadline as expiry, generates a new code, and reconnects.

4. **`ObservedHost` has no interface body in the spec.** Section 3.1 names the
   field and says what it carries in prose; the struct is defined here from that
   description (`identity`, `capacity`, `load`, `listeners`, `security`,
   snake_case throughout) and the plane's Zod schema has to match it or one side
   moves.

5. **A crontab line has no name.** `Resource` is keyed by `(server, kind, name)`,
   but a crontab entry carries no identity of its own, so names are synthesised
   positionally — `root-1`, `root-2`. Re-ordering the crontab therefore renames
   the resources. Stable names need cron entries the daemon *installs* (with a
   comment marker or as systemd timers), which is also what
   `prototype-reality-check` invented #2 needs for last-run and exit status.

6. **A change names a resource the daemon cannot resolve.** `Change.target` and
   `op.resource_id` are plane-side resource ids, and the daemon holds none
   (#13) — it addresses the box by container name. This build reads `kind` and
   `name` from the change's `after`/`before` payload, and expects the same two
   fields on the `op` frame; an op without a name is refused rather than
   guessed at. Either the plane sends them, or the daemon has to keep an
   id-to-name map, which is state it is not supposed to have.

7. **`AppSpec` here is the daemon's slice of the kind, not the whole schema.**
   `source`, `build`, `domains`, `replicas` and `healthcheck` are absent: they
   belong to the build and proxy slices. `env` arrives already resolved —
   secret resolution is its own slice (ADR-0008), and this daemon dereferences
   nothing.

Smaller ones: `state.rev` is treated as monotonic per daemon process and
restarts at 1 after a restart (the plane reconciles on every full snapshot, so
this only matters if it compares revs across connections); `Observed.detail` is
`Record<string, unknown>` in the spec, so the container keys this daemon emits
(`container_id`, `image`, `state`, `status`, `labels`, `created_at`) are a
convention, not a contract.
