import { DurableObject } from "cloudflare:workers";
import type { DeploymentLogEntry } from "../schema";

// docs/architecture.md §3.4 — one StreamDO per deployment, addressed `deployment:<id>`:
//
//   docker compose ──▶ cockpitd ──WSS──▶ ServerDO ──▶ StreamDO ──WS──▶ browser
//
// ServerDO owns the daemon socket and calls `append` here; this object owns the ordered
// replay tail and the browser subscribers. Splitting them is what lets a browser watch a
// deployment without ever touching the socket the daemon is on.
//
// ## The tail is not the archive
//
// `append` keeps at most MAX_TAIL_ENTRIES chunks. A build that prints a million lines
// evicts its own beginning rather than growing DO storage without a bound — but eviction is
// *counted and reported*, never silent: `stream_open` carries `retained_from`, `evicted`,
// and `gap`, so a subscriber can say "earlier output is gone" instead of rendering a
// truncated log as if it were complete.
//
// R2 archival (architecture.md §2 "blobs | R2 | log archives") is deliberately NOT here
// yet. The seam it will attach to is `#evict` (chunks leaving the tail) and `final` (the
// stream is terminal and complete). Until that exists, a deployment's durable log is
// whatever fits in the tail, and the UI must not claim otherwise.
export class StreamDO extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    // Reconnect replay: `after` is the last sequence the subscriber already rendered, so it
    // resumes exactly where it left off instead of re-drawing the whole tail. Absent or
    // unparseable means "from the start of what is retained" — read as absent-or-not rather
    // than coerced, because `Number(null)` is 0, which would silently turn a first-time
    // subscriber into one that has already seen sequence 0 and skip its first chunk.
    const requested = new URL(request.url).searchParams.get("after");
    const after = requested === null ? Number.NaN : Number(requested);
    const resumeFrom = Number.isSafeInteger(after) && after >= 0 ? after + 1 : 0;

    const meta = await this.#meta();
    const backlog = await this.#read(resumeFrom);

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);

    // Sent before the 101 is returned: the socket pair is already live, so these queue and
    // arrive in order the moment the client accepts. The subscriber therefore knows what it
    // is looking at *before* the first line lands.
    pair[1].send(
      JSON.stringify({
        type: "stream_open",
        deployment_id: this.#deploymentId(request),
        retained_from: meta.firstSeq,
        last_seq: meta.lastSeq,
        evicted: meta.evicted,
        terminal: meta.terminal,
        // Output this subscriber never saw is unrecoverable from this object: entries were
        // actually evicted, and it asked to resume from before what is left. `evicted > 0`
        // is load-bearing — a stream whose first chunk carries a `dropped` count starts at
        // a non-zero sequence, and a fresh subscriber (resumeFrom 0) would otherwise be
        // told the tail lost something it never held. The daemon's own loss is reported by
        // `dropped` on the chunk, which is where it happened.
        gap: meta.evicted > 0 && meta.firstSeq !== null && resumeFrom < meta.firstSeq,
      }),
    );
    for (const entry of backlog) pair[1].send(JSON.stringify(logMessage(entry)));

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /**
   * One chunk, from ServerDO, already validated against `StreamDataFrameSchema` there.
   *
   * Ordering is enforced, not assumed: a chunk whose sequence the tail has already seen is
   * dropped rather than appended or re-broadcast, so a daemon that reconnects and resends
   * cannot duplicate or reorder a log. That makes `append` idempotent per sequence, which is
   * what lets the daemon retry at all.
   *
   * A terminal stream is closed for good. Once a `final` chunk has landed, subscribers have
   * been told the deployment stopped producing output and an archiver may already have
   * treated the log as complete; appending after that would make both statements false.
   */
  async append(entry: DeploymentLogEntry): Promise<{ accepted: boolean; last_seq: number }> {
    const meta = await this.#meta();
    if (meta.terminal) {
      console.warn("refusing a chunk after the stream ended", { seq: entry.seq });
      return { accepted: false, last_seq: meta.lastSeq ?? -1 };
    }
    if (meta.lastSeq !== null && entry.seq <= meta.lastSeq) {
      return { accepted: false, last_seq: meta.lastSeq };
    }

    await this.ctx.storage.put(logKey(entry.seq), entry);
    meta.lastSeq = entry.seq;
    meta.count += 1;
    if (meta.firstSeq === null) meta.firstSeq = entry.seq;
    if (entry.final) meta.terminal = true;
    await this.#evict(meta);
    await this.ctx.storage.put("meta", meta);

    this.#broadcast(logMessage(entry));
    if (entry.final) {
      // Terminal marker, distinct from the socket closing: a subscriber can tell "this
      // deployment finished producing output" from "my connection dropped, reconnect".
      this.#broadcast({ type: "stream_end", last_seq: entry.seq });
    }

    return { accepted: true, last_seq: entry.seq };
  }

  /** The retained tail, for callers that want it as data rather than as a socket. Not named
   *  `tail`: that is a reserved Workers handler name and the runtime excludes it from the
   *  RPC surface, so a stub call on it fails with "does not implement the method". */
  async readTail(after = -1): Promise<DeploymentLogEntry[]> {
    return this.#read(after + 1);
  }

  // Subscribers are read-only. Anything they send is ignored rather than acted on — there is
  // no browser-originated command on this path, so accepting one would only invent an
  // attack surface.
  async webSocketMessage(): Promise<void> {}

  async #read(fromSeq: number): Promise<DeploymentLogEntry[]> {
    const stored = await this.ctx.storage.list<DeploymentLogEntry>({
      start: logKey(fromSeq),
      end: LOG_KEY_END,
    });

    return [...stored.values()];
  }

  async #meta(): Promise<Meta> {
    return (
      (await this.ctx.storage.get<Meta>("meta")) ?? {
        firstSeq: null,
        lastSeq: null,
        count: 0,
        evicted: 0,
        terminal: false,
      }
    );
  }

  /**
   * Trims the tail back to MAX_TAIL_ENTRIES. The R2 archive seam described above hangs here:
   * what this deletes is exactly what would need to have been written out first.
   *
   * The bound is on entries actually stored, tracked in `meta.count` — NOT on the sequence
   * span. Sequences legitimately jump whenever the daemon reports `dropped`, so a stream
   * that discarded a thousand chunks would look a thousand entries over the limit by
   * arithmetic and evict a tail that was never that large.
   */
  async #evict(meta: Meta): Promise<void> {
    const overBy = meta.count - MAX_TAIL_ENTRIES;
    if (overBy <= 0 || meta.firstSeq === null) return;

    const oldest = await this.ctx.storage.list<DeploymentLogEntry>({
      start: logKey(meta.firstSeq),
      end: LOG_KEY_END,
      limit: overBy,
    });
    if (oldest.size === 0) return;

    await this.ctx.storage.delete([...oldest.keys()]);
    meta.evicted += oldest.size;
    meta.count -= oldest.size;
    // Read back from what actually remains rather than computed from the evicted sequence:
    // the next retained chunk may be many sequences later across a `dropped` gap.
    const [remaining] = await this.ctx.storage.list<DeploymentLogEntry>({
      start: logKey([...oldest.values()].at(-1)!.seq + 1),
      end: LOG_KEY_END,
      limit: 1,
    });
    meta.firstSeq = remaining ? remaining[1].seq : null;
  }

  /** One dead subscriber must not fail the append and cost every other subscriber the
   *  chunk. The runtime closes it; `webSocketClose` is not needed for cleanup. */
  #broadcast(message: Record<string, unknown>): void {
    const encoded = JSON.stringify(message);
    for (const subscriber of this.ctx.getWebSockets()) {
      try {
        subscriber.send(encoded);
      } catch (err) {
        console.warn("dropping a log subscriber that could not be written to", { err });
      }
    }
  }

  /** Route-set, never subscriber-set: this object is addressed by deployment id and only
   *  echoes back the one the route resolved. */
  #deploymentId(request: Request): string | null {
    return request.headers.get("x-cockpit-deployment-id");
  }
}

/** The subscriber-facing envelope for one chunk. `type` is written last so a stray `type`
 *  on a stored entry can never masquerade as a different kind of frame. */
function logMessage(entry: DeploymentLogEntry): Record<string, unknown> {
  return { ...entry, type: "log" };
}

/** The one place a deployment id becomes a StreamDO name. Both writers (ServerDO) and
 *  readers (the logs route) go through it, so they cannot address different objects. */
export function streamName(deploymentId: string): string {
  return `deployment:${deploymentId}`;
}

/** Roughly a long build's output. Per chunk the schema caps `data` at 8 KiB, so the tail is
 *  bounded at ~8 MB of storage in the worst case and far less in practice. */
const MAX_TAIL_ENTRIES = 1000;

// Zero-padded so `storage.list`'s lexicographic order is sequence order. 16 digits covers
// any sequence a uint64 counter reaches in practice without overflowing the padding.
function logKey(seq: number): string {
  return `log:${String(seq).padStart(16, "0")}`;
}

/** Exclusive upper bound for every `log:` key — ";" is the character after ":". */
const LOG_KEY_END = "log;";

interface Meta {
  /** Oldest sequence still in the tail; null before the first append. */
  firstSeq: number | null;
  lastSeq: number | null;
  /** Entries actually stored. The eviction bound, because a sequence span over-counts
   *  wherever the daemon reported `dropped` — see `#evict`. */
  count: number;
  /** Chunks that left the tail. Non-zero means this object is no longer the whole log. */
  evicted: number;
  /** The daemon sent `final` — the deployment stopped producing output. */
  terminal: boolean;
}
