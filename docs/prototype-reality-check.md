# Prototype reality check

Every value the prototype renders, traced to what would actually produce it. A
prototype invents data very easily — a plausible-looking field costs nothing to
type and can cost weeks to source — so this is the list of places where the
screens are ahead of the system.

Reviewed against `docs/type-design.md` (entities, daemon protocol) and
`docs/architecture.md` (topology, open questions).

---

## Fine — the daemon or the model already produces these

| shown | comes from |
|---|---|
| `ip`, `arch`, `os` | daemon reads the host; `Server.addr` is already daemon-reported (#4) |
| `cpu %`, `memory %`, `disk %` | daemon `metrics` frame |
| `uptime` | daemon reads the host |
| resource counts, kinds, names, health | `Resource` rows plus `Observed` |
| `exposed at`, ports | `AppSpec.domains`, `ports` |
| `release`, `age` | `Release.rev`, `created_at` |
| commit sha, message, branch | daemon reports `HEAD` after clone |
| step names, durations, failure step | the apply Workflow — one durable step per change |
| build output | daemon `stream_data` frames |
| `by: you / claude-code` | `Plan.created_by` (`Actor`) |
| enrolment state, token age | `Enrolment` |
| `shared` on a canvas node | count of inbound `Link`s ≥ 2 |
| plan pending, impact | `Plan.status`, `Change.impact` |

---

## Invented — shown but nothing produces it

### 1. Instance size (`cpx31`, `ccx13`)

The prototype prints a provider SKU. **The daemon cannot know this.** It can
report core count, total RAM, and disk size; it cannot know that those add up to
a Hetzner `cpx31`. Getting the SKU needs the provider's API, which means holding
provider tokens in the plane — listed as an unresolved question
(`architecture.md §5.3`) precisely because it has a real blast radius.

**Fix:** show what the host reports — `8 vCPU · 8 GB · 46 GB` — instead of a SKU
we would have to ask Hetzner for, or let the operator set it as a label.

### 2. Cron "ran 6h ago"

Last-run time and exit status for a cron job. A crontab entry records neither —
the daemon would have to install jobs as **systemd timers** (which do track
`LastTriggerUSec` and result) rather than crontab lines, or wrap every command
in a reporting shim.

`yoke` used both crontab and systemd units, so this is a real fork in the daemon,
not a display detail. If cron stays crontab-based, the canvas cannot show that
node's last run and should not pretend to.

### 3. A health dot on a domain

The canvas gives `jerry.oflabs.dev` a green dot, but nothing defines what makes a
domain healthy. It would need an actual probe — does the record resolve to this
server, is the certificate valid and unexpired, does the proxy answer. That is a
real check to build and schedule, not a field to read.

**Fix:** either define the probe, or drop the dot and show the record type only.

### 4. Unread notifications

The bell carries an unread badge. `Event` has no read state
(`type-design.md §2.8`) — there is no `read_at`, and no notion of which events
are notifications rather than log entries. Small to add, but currently the badge
is drawn over nothing.

### 5. Canvas layout

Node positions are the operator's mental map and must persist, so a project needs
a stored layout. Not in the model yet. Already noted in the stylesheet; repeated
here because it is a schema change, not a UI concern.

### 6. Volume size (`2.1 GB`)

Real, but not free: it needs `docker system df -v` or a `du`, both of which cost
IO on a production box. It should be sampled on an interval, not read per page
load — which makes it a periodically-refreshed figure with an age, not live.

---

## The rule this list exists to enforce

Before a value goes on a screen, name the frame, query, or probe that produces
it. If the answer is "the provider knows" or "we would have to check," it is
either a decision to take deliberately or a field to remove — never something to
leave on the mock and discover during implementation.
