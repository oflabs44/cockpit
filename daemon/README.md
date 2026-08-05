# cockpitd

The on-box agent. This build does the first slice from
[`docs/development.md`](../docs/development.md) section 4 and nothing more:
**enrol, hello, one state snapshot.** It executes nothing — no `task`, no `op`,
no streams, no `install.sh`.

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
internal/executor     Docker, Firewall, Systemd, Cron interfaces
  /dockercli          Docker over the docker CLI
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

Only `Docker` is implemented. `Firewall`, `Systemd` and `Cron` exist as
interfaces with stubs so their shape is fixed before there are callers, and so
`executor.Set` is already the whole seam the tests fake out.

Docker is read through the `docker` CLI rather than the Go client library: the
daemon is a static single binary with no runtime dependency on the box beyond
Docker itself, the CLI is guaranteed present wherever Docker is, and `docker ps
--format '{{json .}}'` is a stable contract. The client library would pull in a
large dependency tree and an API-version negotiation problem for one read.
`ParsePS` is a pure function, so the parsing is tested without Docker present.

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

Smaller ones: `state.rev` is treated as monotonic per daemon process and
restarts at 1 after a restart (the plane reconciles on every full snapshot, so
this only matters if it compares revs across connections); `Observed.detail` is
`Record<string, unknown>` in the spec, so the container keys this daemon emits
(`container_id`, `image`, `state`, `status`, `labels`, `created_at`) are a
convention, not a contract.
