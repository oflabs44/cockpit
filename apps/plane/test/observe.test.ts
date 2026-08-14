import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authedApp, authedRequest } from "./access";
import type { Deps } from "../src/deps";

// docs/type-design.md §3.1 (amended 2026-08-06): `state` gained `host`/`probes`, the up-frames
// gained `op_result`. Mirrors the same module-level-id-counter and app.fetch(request, env)
// approach as test/enrolment.test.ts — see that file's header comments for why.
let idCounter = 0;

function testDeps(nowMs = 1_700_000_000_000): Deps {
  return {
    clock: { now: () => nowMs },
    ids: { id: (prefix) => `${prefix}_o${idCounter++}` },
  };
}

function waitForMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.addEventListener("message", (event) => resolve(JSON.parse(event.data as string)), { once: true });
  });
}

function tick(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connect(app: ReturnType<typeof authedApp>, secret: string) {
  return app.fetch(
    authedRequest("http://plane.test/daemon", { headers: { upgrade: "websocket", authorization: `Bearer ${secret}` } }),
    env,
  );
}

async function createServer(app: ReturnType<typeof authedApp>, name: string) {
  const res = await app.fetch(
    authedRequest("http://plane.test/servers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, provider: "hetzner", labels: {} }),
    }),
    env,
  );
  return (await res.json()) as { token: string; server: { id: string } };
}

async function enrol(app: ReturnType<typeof authedApp>, name: string) {
  const { token, server } = await createServer(app, name);
  const upgrade = await connect(app, token);
  const ws = upgrade.webSocket;
  if (!ws) throw new Error("expected a websocket");
  ws.accept();
  const welcome = waitForMessage(ws);
  ws.send(
    JSON.stringify({
      type: "hello",
      agent_version: "1.2.3",
      arch: "arm64",
      hostname: "scratch-box",
      auth: { kind: "enrolment", secret: token },
    }),
  );
  await welcome;
  return { ws, server };
}

const HOST_FRAME = {
  identity: { os: "Debian GNU/Linux 12", kernel: "6.1.0", hostname: "scratch-box", uptime_s: 12345 },
  capacity: { cpus: 4, mem_total: 8_589_934_592, swap_total: 0, disks: [{ mount: "/", size: 107_374_182_400, used: 21_474_836_480 }] },
  load: [0.1, 0.2, 0.15],
  listeners: [{ proto: "tcp", addr: "0.0.0.0", port: 22, pid_name: "sshd" }],
  security: {
    sshd: { permit_root_login: "no", password_authentication: "no", max_auth_tries: 3 },
    fail2ban_active: true,
    unattended_upgrades_active: true,
    last_apt_activity_unix: 1_700_000_000,
  },
};

const PROBES_FRAME = { docker: "ok", firewall: "ok", systemd: "unavailable" };

describe("observe: state host + probes", () => {
  it("round-trips a full daemon-shaped state frame through the DO and out of GET /servers/:id", async () => {
    const app = authedApp(testDeps());
    const { ws, server } = await enrol(app, "obs-full");

    ws.send(
      JSON.stringify({
        type: "state",
        rev: 1,
        resources: [{ kind: "app", name: "x", observed: { exists: true, health: "healthy", detail: {}, observed_at: 1 } }],
        host: HOST_FRAME,
        probes: PROBES_FRAME,
      }),
    );
    await tick();

    const detail = await app.fetch(authedRequest(`http://plane.test/servers/${server.id}`), env);
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as {
      observed: { rev: number; resources: unknown[] } | null;
      host: typeof HOST_FRAME | null;
      probes: typeof PROBES_FRAME | null;
    };

    expect(body.observed?.rev).toBe(1);
    expect(body.observed?.resources).toHaveLength(1);
    expect(body.host).toEqual(HOST_FRAME);
    expect(body.probes).toEqual(PROBES_FRAME);
  });

  it("drops a malformed host field but still accepts the rest of the frame", async () => {
    const app = authedApp(testDeps());
    const { ws, server } = await enrol(app, "obs-malformed-host");

    ws.send(
      JSON.stringify({
        type: "state",
        rev: 1,
        resources: [],
        host: { identity: { os: "debian" } }, // missing kernel/hostname/uptime_s, wrong shape
        probes: PROBES_FRAME,
      }),
    );
    await tick();

    const detail = await app.fetch(authedRequest(`http://plane.test/servers/${server.id}`), env);
    const body = (await detail.json()) as {
      observed: { rev: number } | null;
      host: unknown;
      probes: typeof PROBES_FRAME | null;
    };

    // The frame as a whole was accepted (rev stored, no close) — only `host` was dropped.
    expect(body.observed?.rev).toBe(1);
    expect(body.host).toBeNull();
    expect(body.probes).toEqual(PROBES_FRAME);
  });

  it("drops malformed probes without rejecting the frame", async () => {
    const app = authedApp(testDeps());
    const { ws, server } = await enrol(app, "obs-malformed-probes");

    ws.send(
      JSON.stringify({
        type: "state",
        rev: 1,
        resources: [],
        host: HOST_FRAME,
        probes: { docker: "definitely-not-a-status", nonsense_kind: "ok" },
      }),
    );
    await tick();

    const detail = await app.fetch(authedRequest(`http://plane.test/servers/${server.id}`), env);
    const body = (await detail.json()) as { observed: { rev: number } | null; host: unknown; probes: unknown };

    expect(body.observed?.rev).toBe(1);
    expect(body.host).toEqual(HOST_FRAME);
    expect(body.probes).toBeNull();
  });

  it("skips an unrecognized probe kind (forward-compat) but keeps the known-good entries", async () => {
    const app = authedApp(testDeps());
    const { ws, server } = await enrol(app, "obs-unknown-probe-kind");

    ws.send(
      JSON.stringify({
        type: "state",
        rev: 1,
        resources: [],
        host: HOST_FRAME,
        probes: { ...PROBES_FRAME, some_future_probe: "ok" },
      }),
    );
    await tick();

    const detail = await app.fetch(authedRequest(`http://plane.test/servers/${server.id}`), env);
    const body = (await detail.json()) as { observed: { rev: number } | null; probes: typeof PROBES_FRAME | null };

    expect(body.observed?.rev).toBe(1);
    expect(body.probes).toEqual(PROBES_FRAME); // the unknown kind is silently absent, not fatal
  });
});

describe("observe: hello populates arch/agent_version", () => {
  it("stores arch and agent_version from the hello frame onto the server row", async () => {
    const app = authedApp(testDeps());
    const { server } = await enrol(app, "obs-hello-identity");

    const detail = await app.fetch(authedRequest(`http://plane.test/servers/${server.id}`), env);
    const body = (await detail.json()) as { server: { arch: string | null; agent_version: string | null } };

    expect(body.server.arch).toBe("arm64");
    expect(body.server.agent_version).toBe("1.2.3");
  });
});

describe("observe: op_result", () => {
  it("is accepted without closing the socket", async () => {
    const app = authedApp(testDeps());
    const { ws } = await enrol(app, "obs-op-result");

    ws.send(JSON.stringify({ type: "op_result", op_id: "op_123", changed: "in_place" }));
    await tick();
    expect(ws.readyState).toBe(WebSocket.OPEN);

    ws.send(JSON.stringify({ type: "op_result", op_id: "op_456", error: { kind: "refused", message: "no such resource" } }));
    await tick();
    expect(ws.readyState).toBe(WebSocket.OPEN);

    // The socket is still enrolled and answering normal frames afterwards.
    ws.send(JSON.stringify({ type: "state", rev: 1, resources: [] }));
    await tick();
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });
});
