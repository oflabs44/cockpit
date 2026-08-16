import { DurableObject } from "cloudflare:workers";
import { and, eq, isNull } from "drizzle-orm";
import { db, servers, enrolments, deployments } from "../db";
import { sha256Hex, issueCredential } from "../secrets";
import { realDeps } from "../deps";
import { StreamDataFrameSchema } from "../schema";
import { streamName } from "./stream-do";

// docs/architecture.md §2.1 / §3.1, docs/type-design.md §3 — one ServerDO per server,
// holding the daemon's WebSocket and the latest observed snapshot. This class also serves
// two connections it is not, by name, "the server" for:
//
//   - a *pending* claim-code connection, addressed `claim:<secretHash>` instead of
//     `server:<id>` (see routes/daemon-ws.ts for the routing decision). It holds AT MOST ONE
//     socket, unenrolled, until `redeemBind` is called by the redeem route. Its durable-object
//     id never becomes `server:<id>` — `redeemBind` delivers the credential and closes the
//     socket, and the daemon's redial presents that credential and lands on the real
//     per-server object.
//   - a rate limiter, addressed `rl:<category>:<ip>` / `rl:<category>:global`, via `checkRateLimit` only — never
//     receives a WebSocket. Reusing the one DO binding this slice has rather than adding a
//     second class for a five-line counter.
export class ServerDO extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const serverId = request.headers.get("x-cockpit-server-id");
    // Pending (claim-mode) objects hold at most one socket — a second dial with the same
    // code (or a guessed/leaked one landing on the same DO) must not join the broadcast set
    // `redeemBind` sends the credential to. `server:<id>` connections aren't capped here;
    // reconnect-replaces-old-socket is the existing behaviour for those.
    if (!serverId && this.ctx.getWebSockets().length > 0) {
      return new Response("a daemon is already pending on this claim code", { status: 409 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      authKind: request.headers.get("x-cockpit-auth-kind"),
      secretHash: request.headers.get("x-cockpit-secret-hash") ?? "",
      serverId,
      observedAddr: request.headers.get("x-cockpit-observed-addr"),
      enrolled: false,
    } satisfies Session);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const session = ws.deserializeAttachment() as Session;

    try {
      if (typeof message !== "string") return;

      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(message);
      } catch {
        ws.close(4002, "invalid json");
        return;
      }

      if (!session.enrolled) {
        if (frame.type === "hello") {
          await this.#handleHello(ws, session, frame);
          return;
        }
        if (frame.type === "awaiting_claim") {
          await this.#handleAwaitingClaim(ws, session, frame);
          return;
        }
        ws.close(POLICY_VIOLATION, "unenrolled connections may only enrol");
        return;
      }

      if (frame.type === "state") {
        await this.#handleState(ws, session, frame);
        return;
      }
      if (frame.type === "op_result") {
        this.#handleOpResult(session, frame);
        return;
      }
      if (frame.type === "pong") return;
      if (frame.type === "stream_data") {
        await this.#handleStreamData(ws, session, frame);
        return;
      }

      // task_progress/metrics/event: out of scope this slice.
      ws.close(POLICY_VIOLATION, "unsupported frame");
    } catch (err) {
      // An uncaught throw here would otherwise leave the socket open but unresponsive — the
      // daemon waits forever instead of its normal backoff-and-redial. 1011 ("internal error")
      // triggers that reconnect.
      console.error("webSocketMessage failed", { serverId: session.serverId, frameType: typeof message, err });
      ws.close(1011, "internal error");
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    // Only the last socket leaving an object should flip it to disconnected — with the
    // single-pending-socket guard in `fetch()` this is normally trivially true, but it's
    // still the correct check rather than assuming exactly one socket ever exists.
    const stillOpen = this.ctx.getWebSockets().filter((other) => other !== ws);
    if (stillOpen.length > 0) return;
    await this.#markDisconnected(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.#markDisconnected(ws);
  }

  /** Called by the redeem route once the claim is bound: delivers welcome+credential to the
   *  single pending socket this (`claim:<hash>`-addressed) object holds, if any. Idempotent —
   *  a second call (e.g. two racing redeem requests reaching this serialised DO in sequence)
   *  returns `delivered: 0` rather than re-sending, since RPC calls to one DO instance run
   *  one at a time, so `boundServerId` is a reliable guard once the first call sets it. */
  async redeemBind(now: number, serverId: string, credential: string): Promise<{ delivered: number }> {
    const already = await this.ctx.storage.get<string>("boundServerId");
    if (already) return { delivered: 0 };

    const [pending] = this.ctx.getWebSockets();
    if (!pending) return { delivered: 0 };

    pending.send(JSON.stringify({ type: "welcome", server_id: serverId, credential }));
    // Deliver, then close: an enrolment connection "may do nothing but enrol"
    // (type-design §3). Keeping this socket alive made the daemon send its whole first
    // session's state frames HERE — a `claim:<hash>` object `getSnapshot` never reads —
    // so `observed` stayed null on a connected server. Closing forces the daemon's normal
    // backoff-redial with the credential it just persisted, which lands on `server:<id>`.
    // The session keeps `serverId: null` so this close doesn't mark the server
    // disconnected in the gap before the redial.
    pending.close(1000, "enrolled; reconnect with the credential");

    await this.ctx.storage.put("boundServerId", serverId);
    await this.#setConnected(serverId, now);
    return { delivered: 1 };
  }

  async getSnapshot(): Promise<Snapshot | null> {
    return (await this.ctx.storage.get<Snapshot>("snapshot")) ?? null;
  }

  /** Simple fixed-window counter. Addressed `rl:<category>:<ip>` / `rl:<category>:global` —
   *  see the class comment.
   *  `now` comes from the caller's `deps.clock`, not read here — see the removed-`deps`-field
   *  note below. */
  async checkRateLimit(now: number, max: number, windowMs: number): Promise<boolean> {
    const stored = (await this.ctx.storage.get<{ count: number; windowStart: number }>("rl")) ?? {
      count: 0,
      windowStart: now,
    };
    if (now - stored.windowStart >= windowMs) {
      stored.count = 0;
      stored.windowStart = now;
    }
    stored.count += 1;
    await this.ctx.storage.put("rl", stored);
    return stored.count <= max;
  }

  async #handleHello(ws: WebSocket, session: Session, frame: Record<string, unknown>) {
    const auth = (frame.auth ?? {}) as { kind?: string; secret?: string };
    const secretHash = await sha256Hex(auth.secret ?? "");
    if (auth.kind !== session.authKind || secretHash !== session.secretHash) {
      ws.close(4001, "auth mismatch");
      return;
    }

    const presented = {
      hostname: clampField(frame.hostname),
      arch: clampField(frame.arch),
      // Observed by the plane, not clamped from the frame: architecture §3.1 has the
      // operator confirming this is the box they just installed on, and an address the
      // daemon reported about itself would be the weakest part of that.
      addr: session.observedAddr ?? "",
      agent_version: clampField(frame.agent_version),
    };

    if (session.serverId) {
      let credential: string | undefined;
      if (session.authKind === "enrolment") {
        // Burn the token at the same moment its credential is written, not earlier (at HTTP
        // upgrade — routes/daemon-ws.ts only validates it there) and not later: writing the
        // credential first means a transient failure between the two statements leaves the
        // token still usable rather than spent-with-nothing-delivered. The conditional
        // `consumed_at IS NULL` still resolves a race between two connections presenting the
        // same not-yet-burned token — the loser gets no `welcome` here.
        credential = issueCredential(realDeps.ids);
        const credentialHash = await sha256Hex(credential);
        const database = db(this.env.DB);
        await database.update(servers).set({ credentialHash }).where(eq(servers.id, session.serverId));
        const burned = await database
          .update(enrolments)
          .set({ consumedAt: Date.now() }) // socket timestamp, outside replayable run logic
          // determinism rule (docs/type-design.md §1) — see the removed-`deps`-field note below.
          .where(and(eq(enrolments.secretHash, session.secretHash), isNull(enrolments.consumedAt)))
          .run();
        if (burned.meta.changes === 0) {
          ws.close(4006, "token already claimed by another connection");
          return;
        }
      }
      session.enrolled = true;
      ws.serializeAttachment(session);
      // Only write identity fields the daemon reported, so a hello missing one leaves the
      // existing value untouched. Refresh the observed address on every accepted connection;
      // null is more accurate than a stale address when the plane cannot observe one.
      const identity: { arch?: string; agentVersion?: string; addr: string | null } = {
        addr: presented.addr || null,
      };
      if (presented.arch) identity.arch = presented.arch;
      if (presented.agent_version) identity.agentVersion = presented.agent_version;
      await db(this.env.DB).update(servers).set(identity).where(eq(servers.id, session.serverId));
      await this.#setConnected(session.serverId, Date.now());
      ws.send(JSON.stringify({ type: "welcome", server_id: session.serverId, credential }));
      return;
    }

    // Pending claim-code connection: record the daemon-reported identity and the address the
    // plane observed so the operator can confirm them at redeem time (type-design §2.1.1),
    // then wait — no welcome yet.
    const updated = await db(this.env.DB)
      .update(enrolments)
      .set({ presented: JSON.stringify(presented) })
      .where(eq(enrolments.secretHash, session.secretHash))
      .run();
    if (updated.meta.changes === 0) {
      // The code expired or was redeemed by someone else between upgrade and this hello.
      ws.close(4007, "claim code no longer pending");
      return;
    }
    ws.serializeAttachment(session);
  }

  async #handleAwaitingClaim(ws: WebSocket, session: Session, frame: Record<string, unknown>) {
    const code = String(frame.code ?? "");
    const hash = await sha256Hex(code);
    if (hash !== session.secretHash) {
      ws.close(POLICY_VIOLATION, "awaiting_claim code does not match the connection's transport auth");
      return;
    }
    // Tolerated no-op otherwise — part of the enrol handshake, nothing to store yet.
  }

  async #handleState(ws: WebSocket, session: Session, frame: Record<string, unknown>) {
    if (typeof frame.rev !== "number" || !Array.isArray(frame.resources)) {
      // A malformed frame must not overwrite a good snapshot with a coerced/zeroed one.
      ws.close(1008, "malformed state frame");
      return;
    }
    const snapshot: Snapshot = {
      rev: frame.rev,
      resources: frame.resources.map((r) => {
        const resource = r as Record<string, unknown>;
        const observed = (resource.observed ?? {}) as Record<string, unknown>;
        return {
          kind: String(resource.kind ?? ""),
          name: String(resource.name ?? ""),
          observed: {
            exists: Boolean(observed.exists),
            health: String(observed.health ?? "unknown"),
            detail: (observed.detail ?? {}) as Record<string, DetailValue>,
            observed_at: Number(observed.observed_at ?? 0),
          },
        };
      }),
    };

    // Added 2026-08-06 (type-design §3.1). Both are optional on the wire and malformed on an
    // otherwise-good frame must not reject it — drop just the bad field and keep going.
    if ("host" in frame) {
      const host = parseHost(frame.host);
      if (host) snapshot.host = host;
      else console.warn("dropping malformed host field on state frame", { serverId: session.serverId });
    }
    if ("probes" in frame) {
      const probes = parseProbes(frame.probes);
      if (probes) snapshot.probes = probes;
      else console.warn("dropping malformed probes field on state frame", { serverId: session.serverId });
    }

    await this.ctx.storage.put("snapshot", snapshot);
    if (session.serverId) await this.#setConnected(session.serverId, Date.now());
  }

  /**
   * One chunk of a deployment's live output, on its way to the StreamDO a browser is
   * watching (docs/architecture.md §3.4, ADR-0012).
   *
   * Three checks stand between a daemon and an operator's log pane, and none of them trusts
   * the frame:
   *
   *   1. The socket is enrolled and bound to a server. A claim-mode connection has
   *      `serverId: null` and "may do nothing but enrol" (type-design §3) — it cannot write
   *      into anyone's log.
   *   2. The frame parses against the closed `StreamDataFrameSchema`. Zod strips every key
   *      the schema does not name, so no `env`, `token`, or other metadata field a daemon
   *      attaches can reach storage or a subscriber. What is forwarded is a projection, not
   *      the frame.
   *   3. The Deployment exists AND belongs to *this* server. Without the ownership half, an
   *      enrolled daemon on box A could stream fabricated build output into a deployment
   *      running on box B — a cross-tenant write dressed as a log line.
   *
   * A frame failing (2) or (3) closes the socket rather than being ignored. A daemon sending
   * either is not having a bad line, it is misbehaving or misrouted, and its normal
   * backoff-redial is the cheapest correct response.
   */
  async #handleStreamData(ws: WebSocket, session: Session, frame: Record<string, unknown>) {
    if (!session.serverId) {
      ws.close(POLICY_VIOLATION, "stream_data requires a server-bound connection");
      return;
    }

    const parsed = StreamDataFrameSchema.safeParse(frame);
    if (!parsed.success) {
      ws.close(1008, "malformed stream_data frame");
      return;
    }
    const { type: _discriminator, ...entry } = parsed.data;

    // `stream_id` is the Deployment id (see StreamDataFrameSchema) — the same value
    // authorizes the frame and addresses the object it is written to, so there is no way for
    // a daemon to have one deployment checked and another one written.
    if (!(await this.#ownsDeployment(session.serverId, entry.stream_id))) {
      ws.close(POLICY_VIOLATION, "stream_data references a deployment this server does not own");
      return;
    }

    // Awaited, not fired and forgotten: the StreamDO's ordering guarantee is only as good as
    // the order chunks arrive in, and an unawaited RPC would race the next frame off the
    // same socket. It is also the only backpressure this path has.
    await this.env.STREAM_DO.get(this.env.STREAM_DO.idFromName(streamName(entry.stream_id))).append(entry);
  }

  /** D1 says whether this server owns the deployment; the answer is memoised because a
   *  deployment produces one chunk per output line and a read per line would make the log
   *  path cost more in D1 than in transport. Only positive answers are cached — a refusal
   *  closes the socket, so it is never asked twice — and the cache is per-instance, so it
   *  vanishes on hibernation and is simply rebuilt. */
  async #ownsDeployment(serverId: string, deploymentId: string): Promise<boolean> {
    if (this.#ownedDeployments.has(deploymentId)) return true;

    const row = await db(this.env.DB)
      .select({ id: deployments.id })
      .from(deployments)
      .where(and(eq(deployments.id, deploymentId), eq(deployments.serverId, serverId)))
      .get();
    if (!row) return false;

    // A server runs a handful of deployments at once; the bound only stops an unbounded set
    // accumulating across a long-lived instance.
    if (this.#ownedDeployments.size >= 64) this.#ownedDeployments.clear();
    this.#ownedDeployments.add(deploymentId);
    return true;
  }

  #ownedDeployments = new Set<string>();

  /** Outcome of a direct op (type-design §3.1, added 2026-08-06). Nothing consumes this yet — a
   *  later operation slice does — so it's just validated and logged; critically it must not fall
   *  through to the unknown-frame close path. */
  #handleOpResult(session: Session, frame: Record<string, unknown>) {
    const opId = frame.op_id;
    if (typeof opId !== "string" || !opId) {
      console.warn("malformed op_result frame — missing op_id", { serverId: session.serverId });
      return;
    }
    const changed = typeof frame.changed === "string" ? frame.changed : undefined;
    const error = isFrameError(frame.error) ? frame.error : undefined;
    console.log("op_result", { serverId: session.serverId, opId, changed, error });
  }

  async #markDisconnected(ws: WebSocket) {
    const session = ws.deserializeAttachment() as Session | null;
    if (!session?.serverId) return;
    try {
      await db(this.env.DB).update(servers).set({ status: "disconnected" }).where(eq(servers.id, session.serverId));
    } catch (err) {
      console.error("failed to mark server disconnected", { serverId: session.serverId, err });
    }
  }

  async #setConnected(serverId: string, now: number) {
    await db(this.env.DB)
      .update(servers)
      .set({ status: "connected", lastSeenAt: now })
      .where(eq(servers.id, serverId));
  }
}

// Removed the `deps` field this class used to carry (`clock`/`ids`, mirroring `createApp`'s
// injection seam): nothing ever set it — DOs are constructed `(ctx, env)` by the runtime with
// no room for a third constructor arg, and plain instance state doesn't survive hibernation
// anyway, so it was dead. Minimal position taken instead: RPCs invoked from routes
// (`checkRateLimit`, `redeemBind`) take `now` as a parameter from the caller's `deps.clock`,
// keeping those replayable; socket-event paths this object drives itself (`lastSeenAt` on a
// `state`/`hello` frame, a token's burn timestamp) call `Date.now()` directly, each with a
// comment — they're observational timestamps about when the daemon happened to talk to us,
// outside the "no Date.now() in plane logic" determinism rule (docs/type-design.md §1), which
// is about replaying deployments and operations, not logging when a socket event arrived.

const POLICY_VIOLATION = 4003;

// Printable ASCII, capped — daemon-reported identity fields land in `enrolments.presented` and
// are rendered to an operator before they bind a claim; neither an unbounded string nor control
// characters belong there.
function clampField(value: unknown, maxLen = 128): string {
  return String(value ?? "")
    .replace(/[^\x20-\x7e]/g, "")
    .slice(0, maxLen);
}

interface Session {
  authKind: string | null;
  secretHash: string;
  serverId: string | null;
  /** The connection's public source address as the plane saw it, null when unavailable. */
  observedAddr?: string | null;
  enrolled: boolean;
}

// docs/type-design.md §2.4 `Observed.detail` is documented as arbitrary per-kind data, but
// every example given (container id, image digest, uptime, restart count, ufw rule text) is
// scalar. `unknown` and `any` both broke the RPC stub's return-type inference here — `unknown`
// fails the RPC layer's `Serializable<T>` check outright (collapsing `getSnapshot`'s return to
// `never`), and `any` fed into `Serializable`'s own recursive conditional types sent `tsc` into
// "excessively deep" — found by reading `Rpc.Serializable`/`Stubify` in worker-configuration.d.ts,
// not from memory. A closed scalar-value record satisfies `Serializable` without recursion, and
// covers everything this slice actually sends; widen only if a kind needs a nested `detail` value.
type DetailValue = string | number | boolean | null;

interface Snapshot {
  rev: number;
  resources: { kind: string; name: string; observed: ObservedRecord }[];
  host?: HostRecord;
  probes?: Partial<Record<ProbeKind, ProbeStatus>>;
}

interface ObservedRecord {
  exists: boolean;
  health: string;
  detail: Record<string, DetailValue>;
  observed_at: number;
}

// docs/type-design.md §3.1 `ObservedHost` (added 2026-08-06), mirrored from
// daemon/internal/protocol/protocol.go. Same closed-scalar-shape approach as `DetailValue`
// above — every leaf is a plain scalar or an array of scalar-only records, so it satisfies the
// RPC `Serializable<T>` constraint without the recursion that broke `getSnapshot`'s inference.
interface HostRecord {
  identity: { os: string; kernel: string; hostname: string; uptime_s: number };
  capacity: {
    cpus: number;
    mem_total: number;
    swap_total: number;
    disks: { mount: string; size: number; used: number }[];
  };
  load: [number, number, number];
  listeners: { proto: string; addr: string; port: number; pid_name: string }[];
  security: {
    sshd: { permit_root_login: string; password_authentication: string; max_auth_tries: number };
    fail2ban_active: boolean;
    unattended_upgrades_active: boolean;
    last_apt_activity_unix: number;
  };
}

type ProbeKind = "docker" | "firewall" | "systemd" | "cron" | "host";
type ProbeStatus = "ok" | "unavailable";
const PROBE_KINDS: ProbeKind[] = ["docker", "firewall", "systemd", "cron", "host"];
const PROBE_STATUSES: ProbeStatus[] = ["ok", "unavailable"];

// Minimal structural validation, not a full schema — malformed just means "don't store this
// field," not "reject the frame" (the rest of `state` — resources — is otherwise good).
function parseHost(value: unknown): HostRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;

  const identity = v.identity as Record<string, unknown> | undefined;
  if (
    typeof identity?.os !== "string" ||
    typeof identity.kernel !== "string" ||
    typeof identity.hostname !== "string" ||
    typeof identity.uptime_s !== "number"
  ) {
    return undefined;
  }

  const capacity = v.capacity as Record<string, unknown> | undefined;
  if (
    typeof capacity?.cpus !== "number" ||
    typeof capacity.mem_total !== "number" ||
    typeof capacity.swap_total !== "number" ||
    !Array.isArray(capacity.disks) ||
    !capacity.disks.every(
      (d) =>
        typeof d === "object" &&
        d !== null &&
        typeof (d as Record<string, unknown>).mount === "string" &&
        typeof (d as Record<string, unknown>).size === "number" &&
        typeof (d as Record<string, unknown>).used === "number",
    )
  ) {
    return undefined;
  }

  if (!Array.isArray(v.load) || v.load.length !== 3 || !v.load.every((n) => typeof n === "number")) {
    return undefined;
  }

  if (
    !Array.isArray(v.listeners) ||
    !v.listeners.every((l) => {
      const listener = l as Record<string, unknown>;
      return (
        typeof listener === "object" &&
        listener !== null &&
        typeof listener.proto === "string" &&
        typeof listener.addr === "string" &&
        typeof listener.port === "number" &&
        typeof listener.pid_name === "string"
      );
    })
  ) {
    return undefined;
  }

  const security = v.security as Record<string, unknown> | undefined;
  const sshd = security?.sshd as Record<string, unknown> | undefined;
  if (
    typeof sshd?.permit_root_login !== "string" ||
    typeof sshd.password_authentication !== "string" ||
    typeof sshd.max_auth_tries !== "number" ||
    typeof security?.fail2ban_active !== "boolean" ||
    typeof security.unattended_upgrades_active !== "boolean" ||
    typeof security.last_apt_activity_unix !== "number"
  ) {
    return undefined;
  }

  return {
    identity: {
      os: identity.os,
      kernel: identity.kernel,
      hostname: identity.hostname,
      uptime_s: identity.uptime_s,
    },
    capacity: {
      cpus: capacity.cpus,
      mem_total: capacity.mem_total,
      swap_total: capacity.swap_total,
      disks: (capacity.disks as Record<string, unknown>[]).map((d) => ({
        mount: d.mount as string,
        size: d.size as number,
        used: d.used as number,
      })),
    },
    load: v.load as [number, number, number],
    listeners: (v.listeners as Record<string, unknown>[]).map((l) => ({
      proto: l.proto as string,
      addr: l.addr as string,
      port: l.port as number,
      pid_name: l.pid_name as string,
    })),
    security: {
      sshd: {
        permit_root_login: sshd.permit_root_login as string,
        password_authentication: sshd.password_authentication as string,
        max_auth_tries: sshd.max_auth_tries as number,
      },
      fail2ban_active: security.fail2ban_active as boolean,
      unattended_upgrades_active: security.unattended_upgrades_active as boolean,
      last_apt_activity_unix: security.last_apt_activity_unix as number,
    },
  };
}

function parseProbes(value: unknown): Partial<Record<ProbeKind, ProbeStatus>> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const result: Partial<Record<ProbeKind, ProbeStatus>> = {};
  for (const [kind, status] of Object.entries(value as Record<string, unknown>)) {
    // Forward-compat: a probe kind this version doesn't know about yet is skipped, not fatal —
    // an older plane shouldn't lose every known-good probe because a newer daemon added one.
    // A *known* kind with a malformed status is different: that's not a new kind, it's bad
    // data, so it still rejects the whole field (probes has no per-entry fallback to store).
    if (!PROBE_KINDS.includes(kind as ProbeKind)) continue;
    if (!PROBE_STATUSES.includes(status as ProbeStatus)) return undefined;
    result[kind as ProbeKind] = status as ProbeStatus;
  }
  return result;
}

function isFrameError(value: unknown): value is { kind: string; message: string } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.kind === "string" && typeof v.message === "string";
}
