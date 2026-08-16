import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authedApp, authedRequest } from "./access";
import { db, deployments, projects, resources } from "../src/db";
import { streamName } from "../src/durable-objects/stream-do";
import type { Deps } from "../src/deps";
import type { DeploymentLogEntry } from "../src/schema";

// The log transport end to end (ADR-0012, docs/architecture.md §3.4):
//
//   daemon socket ──▶ ServerDO ──append──▶ StreamDO ──WS──▶ GET /deployments/:id/logs
//
// Nothing is stubbed: these run inside workerd, so the ServerDO validation, the real
// StreamDO storage, and the real WebSocket fan-out are all exercised.

const NOW = 1_700_000_000_000;

// See the note in enrolment.test.ts: D1 is not test-isolated in this pool, so every id
// minted across the whole file must be unique.
let idCounter = 0;

function testDeps(): Deps {
  return {
    clock: { now: () => NOW },
    ids: { id: (prefix) => `${prefix}_log${idCounter++}` },
  };
}

type App = ReturnType<typeof authedApp>;

function waitForMessage(ws: WebSocket, predicate: (frame: Record<string, unknown>) => boolean) {
  return new Promise<Record<string, unknown>>((resolve) => {
    const onMessage = (event: MessageEvent) => {
      const frame = JSON.parse(event.data as string) as Record<string, unknown>;
      if (!predicate(frame)) return;
      ws.removeEventListener("message", onMessage as EventListener);
      resolve(frame);
    };
    ws.addEventListener("message", onMessage as EventListener);
  });
}

function waitForClose(ws: WebSocket): Promise<{ code: number }> {
  return new Promise((resolve) => {
    ws.addEventListener("close", (event) => resolve({ code: event.code }), { once: true });
  });
}

function tick(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createServer(app: App, name: string) {
  const response = await app.fetch(
    authedRequest("http://plane.test/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, provider: "hetzner", labels: {} }),
    }),
    env,
  );
  expect(response.status).toBe(201);

  return (await response.json()) as { token: string; server: { id: string } };
}

/** A daemon that has completed the hello handshake and holds a live, enrolled socket. */
async function enrolledDaemon(app: App, token: string): Promise<WebSocket> {
  const upgrade = await app.fetch(
    authedRequest("http://plane.test/daemon", {
      headers: { upgrade: "websocket", authorization: `Bearer ${token}` },
    }),
    env,
  );
  expect(upgrade.status).toBe(101);

  const ws = upgrade.webSocket;
  if (!ws) throw new Error("expected a websocket");
  ws.accept();

  const welcome = waitForMessage(ws, (frame) => frame.type === "welcome");
  ws.send(
    JSON.stringify({
      type: "hello",
      agent_version: "0.0.1",
      arch: "arm64",
      hostname: "log-box",
      auth: { kind: "enrolment", secret: token },
    }),
  );
  await welcome;

  return ws;
}

/** A persisted Deployment on `serverId`, with the project and app rows its ownership
 *  foreign keys require. */
async function insertDeployment(serverId: string): Promise<string> {
  const database = db(env.DB);
  const projectId = `prj_log${idCounter++}`;
  const appId = `res_log${idCounter++}`;
  const deploymentId = `dep_log${idCounter++}`;

  await database.insert(projects).values({
    id: projectId,
    serverId,
    name: `project-${idCounter}`,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await database.insert(resources).values({
    id: appId,
    serverId,
    projectId,
    kind: "app",
    name: `app-${idCounter}`,
    configuration: { source: { type: "image", image: "ghcr.io/oflabs44/jerry:1" } },
    configurationVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await database.insert(deployments).values({
    id: deploymentId,
    projectId,
    appId,
    serverId,
    trigger: { kind: "manual", commit: null },
    triggeredBy: { kind: "human", id: "operator" },
    status: "deploying",
    sourceRevision: null,
    configurationSnapshot: {},
    configurationVersion: 1,
    steps: [],
    changes: null,
    workflowId: `wf_log${idCounter++}`,
    releaseId: null,
    createdAt: NOW,
    startedAt: NOW,
    finishedAt: null,
  });

  return deploymentId;
}

function chunk(deploymentId: string, seq: number, overrides: Record<string, unknown> = {}) {
  return {
    type: "stream_data",
    // The stream id IS the Deployment id: one value authorizes the frame and addresses the
    // StreamDO it is written to.
    stream_id: deploymentId,
    seq,
    stage: "build",
    source: "stdout",
    data: `line ${seq}`,
    at: NOW + seq,
    ...overrides,
  };
}

/** What ServerDO forwards: the frame minus its wire discriminator, with the loss markers
 *  the schema fills in when the daemon omits them. */
function entry(deploymentId: string, seq: number, overrides: Record<string, unknown> = {}) {
  const { type: _wire, ...rest } = chunk(deploymentId, seq, overrides);

  return { dropped: 0, final: false, ...rest } as unknown as DeploymentLogEntry;
}

function streamStub(deploymentId: string) {
  return env.STREAM_DO.get(env.STREAM_DO.idFromName(streamName(deploymentId)));
}

async function subscribe(app: App, deploymentId: string, query = "") {
  return app.fetch(
    authedRequest(`http://plane.test/deployments/${deploymentId}/logs${query}`, {
      headers: { upgrade: "websocket" },
    }),
    env,
  );
}

/** Subscribes, accepts the socket, and returns every frame that arrived within `settle` —
 *  the replay burst plus whatever was fanned out while waiting. */
async function subscribedFrames(app: App, deploymentId: string, query = "", settle = 20) {
  const response = await subscribe(app, deploymentId, query);
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  const frames: Record<string, unknown>[] = [];
  ws.addEventListener("message", (event) => {
    frames.push(JSON.parse((event as MessageEvent).data as string));
  });
  ws.accept();
  await tick(settle);

  return frames;
}

describe("deployment log transport: StreamDO", () => {
  it("replays the tail in sequence order and resumes after a given sequence", async () => {
    const app = authedApp(testDeps());
    const { server } = await createServer(app, `logs-order-${idCounter}`);
    const deploymentId = await insertDeployment(server.id);
    const stub = streamStub(deploymentId);

    // Appended out of order on purpose: the tail is ordered by sequence, not by arrival.
    for (const seq of [0, 2, 1, 3]) {
      await stub.append(entry(deploymentId, seq));
    }

    // seq 1 arrived after seq 2 and is refused rather than reordering the log — that
    // rejection is what makes a daemon's retry idempotent.
    const tail = await stub.readTail();
    expect(tail.map((stored) => stored.seq)).toEqual([0, 2, 3]);

    const frames = await subscribedFrames(app, deploymentId, "?after=0");

    expect(frames[0]).toMatchObject({
      type: "stream_open",
      deployment_id: deploymentId,
      retained_from: 0,
      last_seq: 3,
      evicted: 0,
      terminal: false,
      gap: false,
    });
    // Only what the subscriber has not already seen: seq 0 is not re-sent.
    expect(frames.slice(1).map((frame) => frame.seq)).toEqual([2, 3]);
  });

  it("fans a chunk out live to a connected subscriber and marks the stream terminal", async () => {
    const app = authedApp(testDeps());
    const { server } = await createServer(app, `logs-live-${idCounter}`);
    const deploymentId = await insertDeployment(server.id);

    const frames = await subscribedFrames(app, deploymentId);

    // Appended while the subscriber is connected: it must arrive without a reconnect.
    await streamStub(deploymentId).append(
      entry(deploymentId, 0, { source: "stderr", stage: "apply", data: "Container jerry Started" }),
    );
    // `final` is the terminal signal, distinct from the socket closing: a subscriber can
    // tell "the deployment stopped producing output" from "my connection dropped".
    await streamStub(deploymentId).append(
      entry(deploymentId, 1, { final: true }),
    );
    await tick(100);

    expect(frames.map((frame) => frame.type)).toEqual([
      "stream_open",
      "log",
      "log",
      "stream_end",
    ]);
    expect(frames[1]).toMatchObject({ seq: 0, stage: "apply", source: "stderr" });
    expect(frames[3]).toMatchObject({ type: "stream_end", last_seq: 1 });

    // And the terminal marker is durable: a subscriber connecting afterwards is told the
    // stream has ended rather than waiting for output that will never come.
    const later = await subscribedFrames(app, deploymentId, "?after=1");
    expect(later[0]).toMatchObject({ type: "stream_open", terminal: true, last_seq: 1 });
  });

  it("bounds the tail and reports the gap rather than pretending it is the archive", async () => {
    const app = authedApp(testDeps());
    const { server } = await createServer(app, `logs-bound-${idCounter}`);
    const deploymentId = await insertDeployment(server.id);
    const stub = streamStub(deploymentId);

    // One past the 1000-entry bound, so exactly one chunk is evicted.
    for (let seq = 0; seq <= 1000; seq++) {
      await stub.append(entry(deploymentId, seq));
    }

    const tail = await stub.readTail();
    expect(tail.length).toBe(1000);
    expect(tail[0]?.seq).toBe(1);

    // A subscriber asking for the whole log cannot be given it — say so, rather than
    // rendering a truncated log as if it were complete.
    const opened = await subscribedFrames(app, deploymentId, "", 100);
    expect(opened[0]).toMatchObject({ retained_from: 1, last_seq: 1000, evicted: 1, gap: true });

    // A subscriber that already saw everything the tail dropped has no gap: `after` is what
    // it rendered, not what the tail happens to still hold.
    const resumedFrames = await subscribedFrames(app, deploymentId, "?after=500", 100);
    expect(resumedFrames[0]).toMatchObject({ gap: false });
    expect(resumedFrames.length).toBe(1 + 500);
  });

  it("bounds the tail by stored entries, not by the sequence span a dropped gap opens", async () => {
    const app = authedApp(testDeps());
    const { server } = await createServer(app, `logs-dropped-${idCounter}`);
    const deploymentId = await insertDeployment(server.id);
    const stub = streamStub(deploymentId);

    // A daemon under backpressure discarded 5000 chunks: sequences jump, `dropped` says by
    // how much, and only three chunks were ever stored. Bounding on `lastSeq - firstSeq + 1`
    // would read this as 5003 entries and evict a tail holding three.
    await stub.append(entry(deploymentId, 0));
    await stub.append(entry(deploymentId, 5001, { dropped: 5000 }));
    await stub.append(entry(deploymentId, 5002));

    const tail = await stub.readTail();
    expect(tail.map((stored) => stored.seq)).toEqual([0, 5001, 5002]);

    // Nothing was evicted, so a fresh subscriber has no gap in what the tail retained — the
    // loss is reported by `dropped` on the chunk, which is where it actually happened.
    const frames = await subscribedFrames(app, deploymentId, "", 100);

    expect(frames[0]).toMatchObject({ retained_from: 0, last_seq: 5002, evicted: 0, gap: false });
    expect(frames.slice(1).map((frame) => frame.dropped)).toEqual([0, 5000, 0]);
  });

  // `gap` is about this object's tail, not about the daemon's sequence numbers. A daemon
  // that dropped output before its first delivered chunk starts the stream at a non-zero
  // sequence, and a first-time subscriber resumes from 0 — but nothing was ever evicted, so
  // there is nothing the tail lost. Claiming a gap here would send an operator looking for
  // output the plane never held, and hide that the loss is the daemon's, reported inline by
  // `dropped` on the chunk itself.
  it("reports no gap when the tail starts late but has evicted nothing", async () => {
    const app = authedApp(testDeps());
    const { server } = await createServer(app, `logs-first-seq-${idCounter}`);
    const deploymentId = await insertDeployment(server.id);
    const stub = streamStub(deploymentId);

    // The first chunk the plane ever receives is sequence 4200: the daemon discarded
    // everything before it while the socket was down.
    await stub.append(entry(deploymentId, 4200, { dropped: 4200 }));
    await stub.append(entry(deploymentId, 4201));

    const frames = await subscribedFrames(app, deploymentId, "", 100);

    expect(frames[0]).toMatchObject({
      retained_from: 4200,
      last_seq: 4201,
      evicted: 0,
      gap: false,
    });
    // The whole tail is replayed, and the daemon's loss is on the chunk where it happened.
    expect(frames.slice(1).map((frame) => frame.seq)).toEqual([4200, 4201]);
    expect(frames[1]).toMatchObject({ dropped: 4200 });
  });

  it("refuses a chunk that arrives after the stream ended", async () => {
    const app = authedApp(testDeps());
    const { server } = await createServer(app, `logs-terminal-${idCounter}`);
    const deploymentId = await insertDeployment(server.id);
    const stub = streamStub(deploymentId);

    await stub.append(entry(deploymentId, 0));
    await stub.append(entry(deploymentId, 1, { final: true }));

    // Subscribers have already been told the deployment stopped producing output, and an
    // archiver may have treated the log as complete. A later chunk would make both false.
    expect(await stub.append(entry(deploymentId, 2))).toEqual({ accepted: false, last_seq: 1 });
    expect((await stub.readTail()).map((stored) => stored.seq)).toEqual([0, 1]);
  });
});

describe("deployment log transport: GET /deployments/:id/logs", () => {
  it("404s an unknown deployment and 426s a request that is not an upgrade", async () => {
    const app = authedApp(testDeps());

    // No Durable Object may be addressed for an id that does not exist.
    const unknown = await subscribe(app, "dep_does_not_exist");
    expect(unknown.status).toBe(404);

    const { server } = await createServer(app, `logs-guards-${idCounter}`);
    const deploymentId = await insertDeployment(server.id);
    const plain = await app.fetch(
      authedRequest(`http://plane.test/deployments/${deploymentId}/logs`),
      env,
    );
    expect(plain.status).toBe(426);
  });

  it("requires an authenticated operator — a socket is as sensitive as the JSON it streams", async () => {
    const app = authedApp(testDeps());
    const { server } = await createServer(app, `logs-auth-${idCounter}`);
    const deploymentId = await insertDeployment(server.id);

    // `authedRequest` is deliberately not used: no Access token at all.
    const response = await app.fetch(
      new Request(`http://plane.test/deployments/${deploymentId}/logs`, {
        headers: { upgrade: "websocket" },
      }),
      env,
    );
    expect(response.status).toBe(401);
  });
});

describe("deployment log transport: ServerDO admission", () => {
  it("forwards a valid frame from the owning server's daemon", async () => {
    const app = authedApp(testDeps());
    const { token, server } = await createServer(app, `logs-forward-${idCounter}`);
    const deploymentId = await insertDeployment(server.id);
    const daemon = await enrolledDaemon(app, token);

    daemon.send(JSON.stringify(chunk(deploymentId, 0, { stage: "fetch", source: "system" })));
    daemon.send(JSON.stringify(chunk(deploymentId, 1, { stage: "build", source: "stderr" })));
    await tick(100);

    const tail = await streamStub(deploymentId).readTail();
    expect(tail.map((stored) => [stored.seq, stored.stage, stored.source])).toEqual([
      [0, "fetch", "system"],
      [1, "build", "stderr"],
    ]);
  });

  it("refuses a malformed frame instead of storing a coerced one", async () => {
    const app = authedApp(testDeps());
    const { token, server } = await createServer(app, `logs-malformed-${idCounter}`);
    const deploymentId = await insertDeployment(server.id);
    const daemon = await enrolledDaemon(app, token);

    const closed = waitForClose(daemon);
    // `deploying` is a Deployment status, not a log stage — the stage set is the contract.
    daemon.send(JSON.stringify(chunk(deploymentId, 0, { stage: "deploying" })));
    expect((await closed).code).toBe(1008);

    expect(await streamStub(deploymentId).readTail()).toEqual([]);
  });

  it("measures the data limit in utf-8 bytes, as the daemon's own limit does", async () => {
    const app = authedApp(testDeps());
    const { token, server } = await createServer(app, `logs-bytes-${idCounter}`);
    const deploymentId = await insertDeployment(server.id);

    // 3000 four-byte characters: 6000 by JavaScript's `.length` (each is a surrogate pair)
    // but 12000 by Go's `len()`. A character-counting check would wave this through at half
    // its real size.
    const overByBytes = "🚀".repeat(3000);
    expect(overByBytes.length).toBeLessThan(8192);
    expect(new TextEncoder().encode(overByBytes).length).toBeGreaterThan(8192);

    const daemon = await enrolledDaemon(app, token);

    // Multi-byte output well inside the byte limit is accepted first, so this bounds bytes
    // rather than simply refusing non-ASCII output.
    daemon.send(JSON.stringify(chunk(deploymentId, 0, { data: "🚀".repeat(1024) })));
    await tick(100);
    expect((await streamStub(deploymentId).readTail()).length).toBe(1);

    const closed = waitForClose(daemon);
    daemon.send(JSON.stringify(chunk(deploymentId, 1, { data: overByBytes })));
    expect((await closed).code).toBe(1008);
    expect((await streamStub(deploymentId).readTail()).length).toBe(1);
  });

  it("refuses a frame naming another server's deployment", async () => {
    const app = authedApp(testDeps());
    const owner = await createServer(app, `logs-owner-${idCounter}`);
    const intruder = await createServer(app, `logs-intruder-${idCounter}`);
    const deploymentId = await insertDeployment(owner.server.id);

    const daemon = await enrolledDaemon(app, intruder.token);
    const closed = waitForClose(daemon);
    daemon.send(JSON.stringify(chunk(deploymentId, 0)));

    // 4003 is the policy-violation close code: this is an authorisation failure, not a bad
    // line. Without the ownership check a daemon on any box could write into any log.
    expect((await closed).code).toBe(4003);
    expect(await streamStub(deploymentId).readTail()).toEqual([]);
  });

  it("refuses a frame naming a deployment that does not exist", async () => {
    const app = authedApp(testDeps());
    const { token } = await createServer(app, `logs-nodep-${idCounter}`);
    const daemon = await enrolledDaemon(app, token);

    const closed = waitForClose(daemon);
    daemon.send(JSON.stringify(chunk("dep_never_persisted", 0)));
    expect((await closed).code).toBe(4003);
  });

  it("drops every field the contract does not name, so no secret can ride along", async () => {
    const app = authedApp(testDeps());
    const { token, server } = await createServer(app, `logs-secrets-${idCounter}`);
    const deploymentId = await insertDeployment(server.id);
    const daemon = await enrolledDaemon(app, token);

    daemon.send(
      JSON.stringify(
        chunk(deploymentId, 0, {
          // A daemon attaching resolved configuration to a log frame must not be able to
          // get it persisted or fanned out to a browser. The schema is closed; these are
          // stripped, and the frame is still accepted so one careless daemon build does not
          // take the whole log path down.
          env: { DATABASE_URL: "postgres://user:hunter2@db/jerry" },
          token: "ghs_installationtokenthatmustneverland",
          secrets: { STRIPE_KEY: "sk_live_xxx" },
          metadata: { note: "arbitrary" },
        }),
      ),
    );
    await tick(100);

    const [stored] = await streamStub(deploymentId).readTail();
    expect(stored).toBeDefined();
    expect(Object.keys(stored!).sort()).toEqual([
      "at",
      "data",
      "dropped",
      "final",
      "seq",
      "source",
      "stage",
      "stream_id",
    ]);
    expect(JSON.stringify(stored)).not.toContain("hunter2");
    expect(JSON.stringify(stored)).not.toContain("ghs_");
  });
});
