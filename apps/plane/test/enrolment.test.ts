import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { db, enrolments, servers } from "../src/db";
import type { Deps } from "../src/deps";
import { sha256Hex } from "../src/secrets";

// Full handshake tests call `app.fetch(request, env)` directly rather than the deprecated
// `SELF` Fetcher from `cloudflare:test` (its own type declares `@deprecated`) — this still
// exercises the real `/daemon` route, header-based auth resolution, and `ServerDO`, running
// inside the same workerd instance vitest-pool-workers provides, so nothing is stubbed out.

// Module-level, never reset: D1 in this pool is not guaranteed test-isolated the way
// per-test miniflare storage usually is (observed empirically — ids reused across `it()`
// blocks collided on the `servers`/`enrolments` primary keys), so every id minted across the
// whole file must be unique, not just within one test.
let idCounter = 0;

function testDeps(nowMs = 1_700_000_000_000): Deps & { advance(ms: number): void } {
  let now = nowMs;
  return {
    clock: { now: () => now },
    ids: { id: (prefix) => `${prefix}_t${idCounter++}` },
    advance: (ms) => {
      now += ms;
    },
  };
}

function waitForMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.addEventListener("message", (event) => resolve(JSON.parse(event.data as string)), { once: true });
  });
}

function waitForClose(ws: WebSocket): Promise<{ code: number }> {
  return new Promise((resolve) => {
    ws.addEventListener("close", (event) => resolve({ code: event.code }), { once: true });
  });
}

function tick(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connect(app: ReturnType<typeof createApp>, secret: string, extraHeaders: Record<string, string> = {}) {
  return app.fetch(
    new Request("http://plane.test/daemon", {
      headers: { upgrade: "websocket", authorization: `Bearer ${secret}`, ...extraHeaders },
    }),
    env,
  );
}

async function createServer(app: ReturnType<typeof createApp>, name: string) {
  const res = await app.fetch(
    new Request("http://plane.test/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, provider: "hetzner", labels: {} }),
    }),
    env,
  );
  return (await res.json()) as { token: string; server: { id: string } };
}

async function redeem(app: ReturnType<typeof createApp>, code: string, ip: string, body: Record<string, unknown>) {
  return app.fetch(
    new Request(`http://plane.test/enrolments/${code}/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": ip },
      body: JSON.stringify(body),
    }),
    env,
  );
}

describe("enrolment: token", () => {
  it("is single-use — burned in #handleHello, not at connect time", async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const { token } = await createServer(app, "box-a");

    const first = await connect(app, token);
    expect(first.status).toBe(101);
    const ws = first.webSocket;
    if (!ws) throw new Error("expected a websocket");
    ws.accept();

    // Token is still valid pre-hello: a second connect attempt succeeds at the HTTP layer too
    // (routes/daemon-ws.ts no longer burns it) — single-use is enforced once hello burns it.
    const second = await connect(app, token);
    expect(second.status).toBe(101);
    second.webSocket?.accept();

    const welcome = waitForMessage(ws);
    ws.send(
      JSON.stringify({
        type: "hello",
        agent_version: "0.0.1",
        arch: "arm64",
        hostname: "scratch-box",
        auth: { kind: "enrolment", secret: token },
      }),
    );
    const frame = await welcome;
    expect(frame.type).toBe("welcome");
    expect(typeof frame.credential).toBe("string");

    // Now burned — a fresh connect must fail.
    const third = await connect(app, token);
    expect(third.status).toBe(401);
  });

  it("hashes the secret at rest — the row never contains the plaintext token", async () => {
    const { token, server } = await createServer(createApp(testDeps()), "box-b");

    const row = await db(env.DB).select().from(enrolments).where(eq(enrolments.serverId, server.id)).get();
    expect(row).toBeDefined();
    expect(row?.secretHash).not.toBe(token);
    expect(row?.secretHash).not.toContain(token);

    const serverRow = await db(env.DB).select().from(servers).where(eq(servers.id, server.id)).get();
    expect(serverRow?.credentialHash).toBeNull();
  });

  it("expired tokens are rejected", async () => {
    const deps = testDeps();
    const database = db(env.DB);
    const serverId = deps.ids.id("srv");
    const token = "ck_enrol_expired-token-fixture";

    await database.insert(servers).values({
      id: serverId,
      name: "box-c",
      provider: "hetzner",
      addr: null,
      arch: null,
      status: "enrolling",
      agentVersion: null,
      credentialHash: null,
      lastSeenAt: null,
      labels: "{}",
      createdAt: deps.clock.now(),
    });
    await database.insert(enrolments).values({
      id: deps.ids.id("enr"),
      serverId,
      mode: "token",
      secretHash: await sha256Hex(token), // the *same* secret the connect below presents
      presented: null,
      expiresAt: deps.clock.now() - 1, // already expired
      consumedAt: null,
      createdBy: JSON.stringify({ kind: "human", id: "operator" }),
      createdAt: deps.clock.now(),
    });

    const app = createApp(deps);
    const res = await connect(app, token);
    expect(res.status).toBe(401);
  });
});

describe("enrolment: unenrolled connections", () => {
  it("may do nothing but enrol — a state frame before hello closes the socket", async () => {
    const app = createApp(testDeps());
    const { token } = await createServer(app, "box-d");

    const upgrade = await connect(app, token);
    expect(upgrade.status).toBe(101);
    const ws = upgrade.webSocket;
    if (!ws) throw new Error("expected a websocket");
    ws.accept();

    const closed = waitForClose(ws);
    ws.send(JSON.stringify({ type: "state", rev: 1, resources: [] }));

    expect((await closed).code).toBe(4003);
  });
});

describe("enrolment: malformed frames", () => {
  it("rejects a malformed state frame (close 1008) without clobbering a prior good snapshot", async () => {
    const app = createApp(testDeps());
    const { token, server } = await createServer(app, "box-state");

    const upgrade = await connect(app, token);
    const ws = upgrade.webSocket;
    if (!ws) throw new Error("expected a websocket");
    ws.accept();
    const welcome = waitForMessage(ws);
    ws.send(
      JSON.stringify({
        type: "hello",
        agent_version: "0.0.1",
        arch: "arm64",
        hostname: "h",
        auth: { kind: "enrolment", secret: token },
      }),
    );
    await welcome;

    ws.send(
      JSON.stringify({
        type: "state",
        rev: 1,
        resources: [{ kind: "app", name: "x", observed: { exists: true, health: "healthy", detail: {}, observed_at: 1 } }],
      }),
    );
    await tick();

    const closed = waitForClose(ws);
    ws.send(JSON.stringify({ type: "state", rev: "not-a-number", resources: "not-an-array" }));
    expect((await closed).code).toBe(1008);

    const detail = await createApp(testDeps()).fetch(new Request(`http://plane.test/servers/${server.id}`), env);
    const body = (await detail.json()) as { observed: { rev: number } | null };
    expect(body.observed?.rev).toBe(1);
  });
});

describe("enrolment: claim code", () => {
  it("redeem binds the server and delivers welcome+credential on the held socket", async () => {
    const app = createApp(testDeps());
    const claimCode = "TEST-CLAIM-CODE-1";

    const upgrade = await connect(app, claimCode, { "cf-connecting-ip": "203.0.113.20" });
    expect(upgrade.status).toBe(101);
    const ws = upgrade.webSocket;
    if (!ws) throw new Error("expected a websocket");
    ws.accept();

    ws.send(
      JSON.stringify({
        type: "hello",
        agent_version: "0.0.1",
        arch: "arm64",
        hostname: "scratch-box",
        auth: { kind: "enrolment", secret: claimCode },
      }),
    );
    ws.send(JSON.stringify({ type: "awaiting_claim", code: claimCode }));
    // `hello` lands on the pending claim connection (stores `presented` in `enrolments`) before
    // redeem reads it — give it a moment, since it's a separate execution path from the HTTP
    // request below.
    await tick();

    const welcome = waitForMessage(ws);
    const res = await redeem(app, claimCode, "203.0.113.10", { name: "claimed-box", provider: "hetzner" });
    expect(res.status).toBe(200);
    const { server } = (await res.json()) as {
      server: { id: string; status: string; arch: string | null; agent_version: string | null };
    };
    // The daemon's `hello` already reported its identity before redeem ever ran — a claim-mode
    // server shouldn't start its first session with these null.
    expect(server.arch).toBe("arm64");
    expect(server.agent_version).toBe("0.0.1");

    const frame = await welcome;
    expect(frame.type).toBe("welcome");
    expect(frame.server_id).toBe(server.id);
    expect(typeof frame.credential).toBe("string");
  });

  it("double redeem fails", async () => {
    const app = createApp(testDeps());
    const claimCode = "TEST-CLAIM-CODE-2";

    const upgrade = await connect(app, claimCode, { "cf-connecting-ip": "203.0.113.21" });
    upgrade.webSocket?.accept();

    const body = { name: "claimed-box-2", provider: "hetzner" };
    const first = await redeem(app, claimCode, "203.0.113.11", body);
    expect(first.status).toBe(200);

    const second = await redeem(app, claimCode, "203.0.113.11", body);
    expect(second.status).toBe(404);
  });

  it("rate limits redeem attempts to 5 per IP per minute", async () => {
    const app = createApp(testDeps());
    const ip = "203.0.113.99";

    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await redeem(app, "NO-SUCH-CODE", ip, { name: "n", provider: "hetzner" });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 5)).toEqual([404, 404, 404, 404, 404]);
    expect(statuses[5]).toBe(429);
  });

  it("rate limits claim-mode /daemon connects per IP", async () => {
    const app = createApp(testDeps());
    const ip = "198.51.100.5";

    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await connect(app, `RATE-LIMIT-CLAIM-CODE-${i}`, { "cf-connecting-ip": ip });
      statuses.push(res.status);
      res.webSocket?.accept();
    }

    expect(statuses.slice(0, 5)).toEqual([101, 101, 101, 101, 101]);
    expect(statuses[5]).toBe(429);
  });

  it("concurrent dials with the same brand-new code never create duplicate enrolment rows", async () => {
    const app = createApp(testDeps());
    const code = "DEDUP-CLAIM-CODE";

    const ip = { "cf-connecting-ip": "203.0.113.22" };
    const [a, b] = await Promise.all([connect(app, code, ip), connect(app, code, ip)]);
    a.webSocket?.accept();
    b.webSocket?.accept();

    const hash = await sha256Hex(code);
    const rows = await db(env.DB).select().from(enrolments).where(eq(enrolments.secretHash, hash)).all();
    expect(rows.length).toBe(1);
  });

  it("holds at most one pending socket per claim object — a second connect is rejected, not broadcast to", async () => {
    const app = createApp(testDeps());
    const code = "SINGLE-PENDING-CODE";

    const ip = { "cf-connecting-ip": "203.0.113.23" };
    const first = await connect(app, code, ip);
    expect(first.status).toBe(101);
    const ws1 = first.webSocket;
    if (!ws1) throw new Error("expected a websocket");
    ws1.accept();

    const second = await connect(app, code, ip);
    expect(second.status).toBe(409);
    expect(second.webSocket).toBeNull();

    const welcome1 = waitForMessage(ws1);
    const res = await redeem(app, code, "203.0.113.12", { name: "single-pending-box", provider: "hetzner" });
    expect(res.status).toBe(200);

    const frame = await welcome1;
    expect(frame.type).toBe("welcome");
  });

  it("redeem with no daemon holding the socket returns 409 and does not consume the code", async () => {
    const app = createApp(testDeps());
    const code = "GHOST-CLAIM-CODE";

    const upgrade = await connect(app, code, { "cf-connecting-ip": "203.0.113.24" });
    const ws = upgrade.webSocket;
    if (!ws) throw new Error("expected a websocket");
    ws.accept();
    ws.close(1000, "simulated drop");
    // The client-side `close` event isn't a reliable signal in this test harness (observed
    // empirically — it doesn't always fire even though the DO's own `webSocketClose` handler
    // does), so give the server side a moment to process it instead of awaiting it.
    await tick(200);

    const res = await redeem(app, code, "203.0.113.13", { name: "ghost-box", provider: "hetzner" });
    expect(res.status).toBe(409);

    const hash = await sha256Hex(code);
    const row = await db(env.DB).select().from(enrolments).where(eq(enrolments.secretHash, hash)).get();
    expect(row?.consumedAt).toBeNull();
  });
});

describe("enrolment: disconnect accounting", () => {
  it("marks disconnected only when the last socket on the object closes", async () => {
    const app = createApp(testDeps());
    const { token, server } = await createServer(app, "box-multi");

    const first = await connect(app, token);
    const ws1 = first.webSocket;
    if (!ws1) throw new Error("expected a websocket");
    ws1.accept();
    const welcome1 = waitForMessage(ws1);
    ws1.send(
      JSON.stringify({
        type: "hello",
        agent_version: "0.0.1",
        arch: "arm64",
        hostname: "h1",
        auth: { kind: "enrolment", secret: token },
      }),
    );
    const frame1 = await welcome1;
    const credential = frame1.credential as string;

    const second = await connect(app, credential);
    const ws2 = second.webSocket;
    if (!ws2) throw new Error("expected a websocket");
    ws2.accept();
    const welcome2 = waitForMessage(ws2);
    ws2.send(
      JSON.stringify({
        type: "hello",
        agent_version: "0.0.1",
        arch: "arm64",
        hostname: "h2",
        auth: { kind: "credential", secret: credential },
      }),
    );
    await welcome2;

    // The client-side `close` event isn't a reliable signal in this test harness (observed
    // empirically), so give the server side a moment to process each close instead of
    // awaiting it.
    ws1.close(1000, "bye");
    await tick(200);

    let row = await db(env.DB).select().from(servers).where(eq(servers.id, server.id)).get();
    expect(row?.status).toBe("connected"); // ws2 still open

    ws2.close(1000, "bye");
    await tick(200);

    row = await db(env.DB).select().from(servers).where(eq(servers.id, server.id)).get();
    expect(row?.status).toBe("disconnected");
  });
});
