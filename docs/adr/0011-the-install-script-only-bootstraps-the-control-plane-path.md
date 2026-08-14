# The install script only bootstraps the control-plane path

Status: accepted

Amends [`docs/architecture.md`](../architecture.md) §2.4, which specified host hardening as
step 2 of the install script.

`install.sh` has one job: make a box able to talk to the plane. It ensures Docker, installs
`cockpitd` and its unit, records the plane URL, and enrols. It does not harden the host.

Hardening — sshd, users, and a UFW baseline — becomes a later operation the operator opts
into from a client, driven by the plane and executed by the daemon.

## Context

The original five-step script hardened the host between detecting the distro and installing
Docker. Three problems come from that placement.

**The risk is asymmetric with the rest of the script.** Installing Docker and a daemon is
additive and reversible. Rewriting `sshd_config` on a box reached *through* sshd, or
enabling UFW on a box reachable only over the network, can strand the operator. ADR-0001
leaves no break-glass path inside cockpit: when a daemon is down the operator diagnoses over
their own SSH. If the hardening step is what broke SSH, that recovery path is gone. A step
that can remove the only way back does not belong in a one-liner that is piped to a root
shell and re-run without reading.

**Bash makes the baseline invisible.** A UFW baseline applied by a script is state nothing
records. It drifts the moment anyone touches the box, and cockpit cannot tell that it drifted
because it never knew what was applied. The same baseline expressed as `firewall_rule`
resources is reconciled against observed state, carries an actor, and appears in the audit
log like any other change.

**It is the thing cockpit exists to replace.** `CONTEXT.md` describes the `/devops`
playbooks as *a program written in English*, where three runs produce three subtly different
boxes, and says cockpit compiles them into typed, testable operations. A hardening step
written in bash is the same program in a different language. Moving it into operations is not
new scope; it is the original thesis applied consistently.

Opt-in matters as much as the move. The claim-code direction exists for boxes that predate
cockpit, which usually carry hardening the operator already chose. Applying a baseline to
those by surprise, as a side effect of installing an agent, is wrong regardless of how good
the baseline is.

## Decision

### What the install script does

1. Preflight — root, systemd, a supported distro and architecture, free disk, and that the
   plane and the download host are reachable. It refuses anything else rather than working
   partly, and it refuses before it has touched the box.
2. Ensure Docker, verified by `docker info` rather than the binary being on `PATH`, at a
   minimum version, and enabled at boot.
3. Install the versioned `cockpitd` binary, verified against a SHA-256 embedded in the script
   at publish time.
4. Write `/etc/cockpitd/config.json` with the plane URL, install the unit, and start it.
5. Enrol with the token if it was given one, otherwise present the claim code.

It configures nothing inside Docker. Container log rotation and the default address pool are
real problems on a personal VPS, but they are Docker's configuration rather than cockpit's,
and applying them means restarting the Docker daemon — which stops the operator's running
containers. They belong to the same later plane-driven flow as hardening, for the same
reason.

**Anything that might fail, fails hard.** The script does not carry recovery machinery or
model exotic states. It dies naming the cause and the fix, and lets the operator act. This
is a deliberate reversal: earlier drafts guarded rare conditions, and that guarding produced
more defects than the conditions it guarded against.

It stays idempotent. A re-run upgrades the binary and unit, and restarts the daemon only
when something actually changed — an unchanged re-run leaves the running session alone
rather than dropping it for nothing. A re-run on a box that already holds a credential does
not re-enrol, and a token passed to an already-enrolled box is ignored with a message rather
than rebinding — rebinding is an identity change and belongs in the plane, not in a repeated
paste of an old command.

### What the daemon publishes, and who presents it

The daemon writes machine-readable runtime state to `/run/cockpitd/state.json`, and the
installer presents it. The daemon formats nothing for the installer to parse.

```json
{ "state": "awaiting_claim", "claim_code": "4F2K-9TQX",
  "claim_expires_at": 1786829400, "plane": "https://...", "hostname": "lab-nbg1" }
```

`claim_expires_at` is unix seconds, as every other timestamp the daemon emits is. The state
is one of `awaiting_claim`, `connected`, or `disconnected`.

There is no state for a credential that reached the daemon but not the disk, because the
daemon does not allow that state to exist: a credential it cannot persist is a hard exit
naming the write error. It never runs on with a credential only in memory. The alternative —
staying up and describing the risk — needs a flag on the state file, a rule about who may
restart, and advice for a human, and every one of those pieces produced defects worse than
an unwritable `/etc`.

`install.sh` asks `cockpitd status` for the disposition rather than reading these files and
deciding for itself. Three consecutive review rounds found the same defect — the installer
and the daemon disagreeing about what "bound" or "enrolled" meant — and one answer computed
in one place, in Go, where it is testable, is what ended it.

`/run` is correct because a claim code is ephemeral: it rotates on its own ten-minute
deadline and must not survive a reboot. Durable state stays in `/etc/cockpitd/config.json`.
The state name matches the `awaiting_claim` frame already on the wire.

This closes a real gap. The claim block was written to stdout for an operator to read
seconds after the install finished, but `--foreground` only changes the logger — under a
systemd unit that block goes to journald and the operator's terminal shows nothing.

Two consequences follow:

- **`cockpitd claim`** renders the block from the state file. The installer runs it rather
  than formatting anything itself, so the text exists in one place. It also gives the
  operator a first-class way to re-print after the code rotates, after they close the
  terminal, or after a reboot, instead of being told to search the journal.
- **`--token-file`** replaces passing the enrolment token in `argv`, which is world-readable
  through `/proc` and, if written into a unit file, persists a credential on disk long after
  it is burned. The daemon unlinks the file once the token is spent.

### What hardening becomes

A later, opt-in, plane-driven flow. The UFW baseline is `firewall_rule` resources reconciled
by the daemon. sshd changes validate with `sshd -t` before a reload rather than a restart, so
the running session survives a bad config. Container log rotation and the Docker address pool
join it, for the same reason: both restart Docker, and a restart stops running containers.

Nothing in this ADR implements that flow. Today the `Firewall` executor is read-only, so
hardening could not have been an operation in any case.

### Scope discipline

This ADR is deliberately smaller than the drafts that preceded it. A `--dry-run` mode, an
in-Docker configuration step, and machinery for a credential that reaches memory but not disk
were all written and then removed. Each was individually defensible and each produced more
defects than the situation it addressed — the credential machinery produced the two worst
bugs found in review.

cockpit currently has one operator, who owns every box it manages. Guarding against exotic
conditions for a hypothetical second user costs real correctness now for speculative safety
later. Fail hard, name the cause, and let the operator act.

## Consequences

- `install.sh` never edits `sshd_config`, manages users, enables UFW, or writes
  `/etc/docker/daemon.json`. It cannot stop a running container.
- A freshly installed box is not hardened, and its container logs are not rotated. Both are
  now visible, deliberate steps rather than silent side effects, and they are the operator's
  to take.
- A daemon that cannot persist its credential exits. The box is not enrolled, the operator
  sees why, and re-enrolment needs a fresh token because the plane burned the first one.
- Hardening is blocked on write verbs for the `Firewall` executor and on a kind for sshd
  configuration. Both are ordinary resource-model work.
- The installer parses no log output. Its claim path asserts a state file, which is testable.
- `/run/cockpitd` is created by `RuntimeDirectory=` in the unit, so the script never makes it
  and nothing has to clean it up.
- A box that cannot reach the plane now fails the install with a message, instead of looking
  the same as a box that is merely slow.
- The script and the daemon version must be kept in step deliberately, as
  `docs/architecture.md` §2.4 already noted; the embedded digest makes a mismatch loud.
