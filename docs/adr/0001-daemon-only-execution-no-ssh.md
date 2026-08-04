# The daemon is the only execution path; cockpit never uses SSH

Status: accepted

Every managed server runs `cockpitd`, a Go binary that dials **out** to the control plane
over a persistent WSS connection. All observation and all execution flow through that
connection.

cockpit itself never uses SSH — not to execute, and not to onboard. Onboarding is a
one-line install script the operator runs on the box themselves. SSH remains the
operator's own out-of-band access to their own machine; it is not a component of this
system.

Two alternatives were considered and rejected: a control plane that holds SSH keys and
connects to each box on demand (the incumbent `yoke` model), and an onboarding path where
a laptop CLI SSHes in to install the daemon.

## Why the daemon, not SSH execution

**"SSH first, add push later" is not additive.** It sounds incremental but it is two
*executors*. Every operation — deploy, logs, metrics, exec, firewall, cron — would be
implemented once against SSH and again against the daemon, and both carried forever,
because boxes onboarded under the SSH model cannot be dropped.

**The battle-tested part is transport-independent.** What is proven in `yoke` is the
*command knowledge*: the exact `docker run` invocations, UFW and cloud-firewall
mediation, the healthcheck poll, typed errors. None of that is SSH. It ports into the
daemon unchanged. Only the SSH plumbing — the easy, replaceable part — is discarded.

**SSH cannot satisfy the plane's constraints.** The control plane is serverless
(ADR-0002), and a Worker cannot realistically hold long-lived SSH sessions: it would need
an SSH client implementation in JS over raw TCP, plus fleet-root private key material
inside a request-scoped runtime. This decision and ADR-0002 are the same decision seen
from two sides.

**Security is strictly better inverted.** Under SSH, one key is root-equivalent across the
whole fleet. Under the daemon, each server holds its own credential, individually
revocable, and the plane holds no key material at all.

**Push beats poll for the things that matter.** Container died, health changed, disk at
90%, deploy step finished — these are events. Over SSH they can only be discovered by
polling, which is both late and expensive at fleet scale.

**Reachability.** Outbound-only means no inbound port 22 exposure, and boxes behind NAT
or restrictive egress-only firewalls work with no special handling.

## Why the install script, not SSH onboarding

An earlier draft of this decision had the plane unable to bootstrap a server — since it
cannot SSH — and therefore required a laptop CLI on the onboarding path. That was wrong:
the box does not need to be reached, it needs to be *started*. Inverting the direction
removes the requirement entirely.

**One versioned code path instead of an interpreted procedure.** The `/devops`
`bootstrap-server` playbook was prose an agent followed, so three runs produced three
subtly different boxes. A shell script served by the plane is the same on every host, is
versioned with the daemon, and can be tested.

**No component needs SSH access to the fleet.** Not the plane, not the CLI, not the agent.
This is a categorically smaller attack surface than "some machine holds a key that opens
every box."

**It is the proven pattern.** Tailscale, Netdata, and Coolify all onboard this way, for
the same reasons.

**It removes the CLI from the critical path**, which in turn makes the CLI an ordinary
optional client rather than a structurally required component (ADR-0005).

Two enrolment directions are supported:

- **Pre-authorised (default).** The operator creates the server in the UI, CLI, or over
  MCP and receives a one-liner with a short-lived, single-use enrolment token embedded.
  The box comes up already named and configured.
- **Claim code.** The operator runs the bare install script on an existing box; the daemon
  prints a short, short-lived, single-use code, redeemed in any client to bind the box to
  a `Server`. For hosts that predate cockpit, or where templating a token in is awkward.

## Consequences

- A second artifact to build, version, upgrade, and debug. Daemon upgrade must be a
  managed operation (the plane knows every daemon's version and can drive a rollout), and
  plane/daemon version skew must be an explicit, tested condition.
- **The install script is a security-critical artifact.** It is fetched over HTTPS and
  piped to a shell with root. It must be versioned, integrity-verifiable, reproducible
  from the repo, and never templated with anything but the plane URL and an enrolment
  token.
- **Enrolment tokens leak by construction** — they land in shell history and the process
  list. Mitigated by making them short-lived (minutes), single-use, and scoped to
  enrolling exactly one server. Claim codes carry the same properties, plus rate limiting,
  since they are guessable in a way tokens are not.
- **Enrolment is operator-initiated and unauthenticated at the box end.** The plane must
  therefore treat first contact as untrusted until the token or claim code is validated,
  and must surface the enrolling host's identity to the operator before binding.
- **When the daemon is down, the box is opaque to cockpit.** There is no fallback path
  inside the product. The operator diagnoses over their own SSH and re-runs the install
  script, which is idempotent and re-enrols. This is a deliberate trade: no break-glass
  path inside cockpit means no standing fleet-wide credential to protect.
- The daemon holds a credential on a box that may be compromised. Credentials are
  per-server and scoped: a daemon can act only on its own server's resources. Revocation
  is a plane operation and a revoked daemon fails closed.
- The daemon is stateless (CONTEXT #12): it carries no desired state and no database, so a
  reconnect re-syncs from observed reality rather than from anything it remembered.
