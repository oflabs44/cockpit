# Development — dogfooding on a real box

cockpit is developed against real servers from the first feature, not simulated ones. This
is the loop that makes that practical.

The dial-out design (ADR-0001) helps here more than anywhere: **your laptop never needs to
be reachable.** The daemon only needs to reach a URL, so there is no inbound access, no
port forwarding, and no VPN in the development path.

---

## 1. Two planes, one scratch box

```
cockpit-dev.workers.dev     dev Worker — own D1, own DO namespace, own R2
        ▲
        │ WSS
   lab-nbg1                 scratch VPS, wiped freely, ~€4/mo

cockpit.oflabs.dev          the real plane
        ▲
   prod-fsn1, edge-ash      boxes you actually care about
```

**A box enrolled to dev cannot be driven by prod, or the reverse.** The per-server
credential is issued by a specific plane, so that isolation is a property of the model
rather than a convention to remember. This matters more than it sounds: dogfooding means
running unfinished code against machines, and the cheapest way to lose a real box is a dev
plane that can reach it.

The scratch box should be genuinely disposable. Re-running `install.sh` is idempotent, and
being willing to destroy and re-enrol it is what makes the loop honest — a dev box you are
afraid to break stops being a test.

---

## 2. Three tiers, fastest first

Most iterations should never touch a network.

### Tier 1 — fakes, on your machine

Executors sit behind interfaces (`Docker`, `Firewall`, `Systemd`, `Cron`), so handler logic
runs against fakes with no box at all. This is where the bulk of daemon logic is tested,
and the seam exists specifically so those tests are possible. Without it every test needs a
VPS, and tests that need a VPS stop being written.

### Tier 2 — local Linux container

Run `cockpitd` in a Linux container with `docker.sock` mounted. Docker ops — the majority
of the interesting logic — become testable with no VPS in the loop. UFW and systemd are not
available there, so those still need tier 3, but this takes most iterations off the
network.

### Tier 3 — the scratch VPS

The real thing: real Docker, real UFW, real systemd, real network. Where anything touching
the host, the firewall, or the install path finally gets proven.

---

## 3. The loop

**The plane is fast.** `wrangler deploy` to the dev Worker takes seconds, so no tunnel is
needed — edit, deploy, and the daemon reconnects. A Cloudflare Tunnel to a local
`wrangler dev` is possible but is complexity that buys little.

**The daemon is the slow half**, so it gets the ergonomics:

```sh
make daemon-push            # GOOS=linux GOARCH=arm64 go build, copy to the box
```

Then, in a shell on the box:

```sh
./cockpitd --foreground --plane https://cockpit-dev.workers.dev
```

`--foreground` runs it in the terminal rather than as a systemd unit: logs to stdout,
`Ctrl-C` to stop, no unit lifecycle and no second window tailing `journalctl`. Edit,
rebuild, `Ctrl-C`, re-run.

The flags exist for development specifically:

| flag | normally | in development |
|---|---|---|
| `--foreground` | runs as a systemd unit | runs in your terminal |
| `--plane <url>` | baked into config at install | point the same binary at dev or prod |
| `--token <tok>` | consumed once by the installer | enrol a throwaway daemon by hand |

> **The developer's SSH is not cockpit's SSH.** `make daemon-push` uses your own key to
> copy a binary to a box you own. That does not violate ADR-0001, which is about what the
> *product* does — cockpit never uses SSH; you may use it freely. Worth stating because the
> two look identical in a terminal and only one is a design violation.

---

## 4. What to build first

Enrol → `hello` → send one `state` snapshot of observed containers. Nothing else.

That single path exercises the credential exchange, the `ServerDO` connection, the
reconnect and backoff logic, and the observation model — and every later feature sits on
top of it. A daemon that can only observe is already useful: it makes the servers list and
the resource table real, which is most of the UI.

Deliberately not first: deployments, operations, builds, and streaming. Each assumes the
connection and observation model already work.

---

## 5. Things that will bite

- **Version skew.** The plane and daemon will drift constantly during development. The
  plane knows every daemon's version; make it say so loudly in dev rather than failing
  obscurely on an unknown frame.
- **The install script and the daemon version must be kept in step** now that the script is
  a static artifact and the plane no longer serves the matching pair (§2.4).
- **Idempotence is not automatic.** Every op claims `create | in_place | replace | no_op`,
  and the claim is only true if it was tested — run every op twice in tier 1 and assert the
  second is `no_op`.
- **A wiped scratch box must re-enrol cleanly.** Test destroy-and-recreate early; it is the
  path a real operator hits after a provider incident, and it is easy to leave broken while
  everything else works.
