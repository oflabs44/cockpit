# Secrets are resolved on the box, by the daemon

Status: accepted

This decides the **seam only**. Which secret managers cockpit supports, and how each
authenticates from a server, is deliberately left open.

Four things are settled:

1. **Resolution happens on the box, in the daemon**, immediately before the value is used,
   and the value is never persisted anywhere — not in D1, not in a git snapshot, not in a
   log line, not in an API response, not on the daemon's disk.
2. **A secret reference is a URI whose scheme names a provider.**
   `op://…`, `aws://…`, `vault://…`, `ck://…`.
3. **Provider configuration is data**, not constants in code: `secret_provider` is an
   account-scoped resource kind (ADR-0007) holding that provider's own auth config.
4. **v1 ships exactly one provider** — 1Password, since it is already the operator's
   boundary.

## Why the seam has to be decided now

Everything else about secrets can wait. This cannot, because it determines the daemon
protocol, the apply flow, and the security model at once — and because the *easiest* first
implementation is the wrong one.

The path of least resistance is "the plane resolves the reference and passes the value down
to the daemon." It needs no vault access on any server and is a few lines. It also puts
plaintext secrets through the component that was specifically designed never to hold key
material (ADR-0001), and once the apply path is built that way, unwinding it means changing
the protocol, the trust model, and every provider integration at the same time.

So the decision is recorded before implementation rather than after, and the shortcut is
named so it is not taken by accident.

## Why the daemon, and not the alternatives

**The plane cannot resolve.** cockpit holds no SSH keys precisely so a compromised control
plane cannot reach the fleet. Handing it plaintext secrets restores exactly the blast
radius that decision removed — the plane would hold, transiently, every credential every
app uses.

**The operator's browser cannot resolve**, though it is tempting: it keeps vault access off
the servers entirely and the operator's vault session already exists. But it makes every
apply require a human at a keyboard, which kills agent-initiated deploys, scheduled
deploys, and auto-restart-on-failure. That is the product thesis (CONTEXT #3), not an
edge case.

**The daemon can.** It already holds a per-server credential, already runs as root on the
box, and is already the only component that touches the container. Resolving one step
before `docker run` means the value exists in memory on the machine that was always going
to have it, and nowhere else.

**And it makes the provider question answer itself.** Every secret manager already has a
native story for authenticating a machine — AWS has IAM roles, Vault has an agent,
1Password has scoped service accounts. Resolving on the box lets each provider use its own
mechanism, instead of cockpit inventing one and forcing every provider through it.

## Why a URI scheme

A ref must survive being stored, diffed, logged, and shown in a UI — so it has to be a
string that is safe in all four places and still says which provider owns it. A scheme does
that in one token, is already the shape 1Password uses, and costs nothing to adopt now
versus a migration later.

It also keeps the value/reference distinction visible to a reader: `op://Personal/jerry/key`
is obviously a pointer, where an opaque id would not be.

## Consequences

- **Vault credentials spread to the servers.** This is the real cost and it is accepted.
  Mitigated by scope: a server's provider credential should reach only the items that
  server's resources reference, and it is revocable per box like its cockpit credential.
  It is strictly narrower than the alternative of one credential that opens everything.
- **A server cannot deploy while its provider is unreachable.** Resolution is on the
  critical path of every apply. Failures must be a typed, legible error naming the ref and
  the provider — not a container that starts with an empty env var, which is the failure
  mode that produces a silent outage.
- **Rotation requires a redeploy.** Env vars are set at container creation, so rotating a
  value in the vault does not affect a running container. This must be stated in the UI
  where a secret is shown, because it is the single most likely misunderstanding — the same
  property Laravel Cloud documents as "redeploy affected environments."
- **Changing which secrets a resource uses changes saved configuration.** The next
  deployment or configuration apply uses the new reference (ADR-0009). Rotating the value
  behind an unchanged reference requires a redeploy because the running environment does
  not update itself.
- **A precedence rule is now required.** When a resource-level env var and a linked secret
  share a key, the resource-level value wins, and the UI must show that one is shadowing
  the other rather than silently dropping it.
- **cockpit can never show a secret's value**, in any client, because it never has one.
  This falls out of the design rather than being a rule to enforce — the property Laravel
  Cloud achieves with browser-side encryption and KMS.
- **`ck://` remains possible but is not v1.** A cockpit-held encrypted value would make
  cockpit a secret store, with the key management, rotation, and audit obligations that
  implies. It is left in the scheme space so the option is open, not because it is planned.

## Deliberately left open

- Which providers beyond 1Password, and in what order.
- How each provider's credential is delivered to a server and rotated.
- Whether a build needs secrets, and if so how they are scoped differently from runtime.
- Per-scope defaults and inheritance, if projects ever need shared secrets.
