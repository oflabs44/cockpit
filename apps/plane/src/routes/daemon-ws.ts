import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import type { AppEnv } from "../app";
import { db, enrolments, servers } from "../db";
import { sha256Hex } from "../secrets";
import { CLAIM_CONNECT_LIMITS, withinRateLimit } from "../rate-limit";

// WS /daemon — docs/type-design.md §4. Routing decision for this slice (flagged in the
// enrolment summary as the smallest position taken on an underspecified point):
//
// The daemon presents its secret in the upgrade request's `Authorization` header, so the
// Worker resolves *who* before choosing a Durable Object — never a bare `idFromName` on
// unauthenticated input.
//
//   - `ck_cred_…`  → per-server credential. D1 lookup by hash. DO `server:<id>`.
//   - `ck_enrol_…` → pre-authorised enrolment token (from `POST /servers`). D1 lookup only —
//     NOT burned here. Burning happens in `ServerDO#handleHello`, at the same moment the
//     credential is written, so a transient failure can never leave the token spent with no
//     credential delivered (see the class comment there).
//   - anything else → claim-code shaped material. Architecture §3.1 has the daemon dial in
//     "identified only by that code" — the plane never minted it — so an unrecognised,
//     non-`ck_`-prefixed secret is treated as a fresh claim code and its `Enrolment` row is
//     upserted here (`ON CONFLICT DO NOTHING` on `secret_hash`, so two concurrent dials with
//     the same not-yet-seen code can't both insert). DO `claim:<hash>`, a *pending* object
//     (see the `ServerDO` class comment) that holds the socket until
//     `POST /enrolments/:code/redeem` tells it to send `welcome`. Rate-limited by IP and
//     globally (type-design §2.1.1) — each connect is a D1 write plus a DO, unlike the other
//     two branches which only ever read an already-issued secret.
//
// `hello`'s own `auth` is still validated inside the DO against what this route resolved,
// per the task brief — two independent checks, not one trusted blindly.
export async function daemonWsHandler(c: Context<AppEnv>) {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return c.text("expected websocket", 426);
  }

  const secret = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!secret) return c.text("missing credentials", 401);

  const deps = c.var.deps;
  const database = db(c.env.DB);
  const now = deps.clock.now();
  const secretHash = await sha256Hex(secret);

  let doName: string;
  let authKind: "credential" | "enrolment";
  let serverId: string | null = null;

  if (secret.startsWith("ck_cred_")) {
    const row = await database.select().from(servers).where(eq(servers.credentialHash, secretHash)).get();
    if (!row) return c.text("unknown credential", 401);
    authKind = "credential";
    serverId = row.id;
    doName = `server:${row.id}`;
  } else if (secret.startsWith("ck_enrol_")) {
    const row = await database
      .select()
      .from(enrolments)
      .where(and(eq(enrolments.secretHash, secretHash), eq(enrolments.mode, "token")))
      .get();
    if (!row || row.consumedAt || row.expiresAt <= now || !row.serverId) {
      return c.text("invalid or expired token", 401);
    }
    authKind = "enrolment";
    serverId = row.serverId;
    doName = `server:${row.serverId}`;
  } else {
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    if (!(await withinRateLimit(c.env.SERVER_DO, now, ip, CLAIM_CONNECT_LIMITS))) {
      return c.text("rate limited", 429);
    }

    const existing = await database
      .select()
      .from(enrolments)
      .where(and(eq(enrolments.secretHash, secretHash), eq(enrolments.mode, "claim_code")))
      .get();
    if (existing && (existing.consumedAt || existing.expiresAt <= now)) {
      return c.text("claim code expired or already redeemed", 401);
    }
    if (!existing) {
      await database
        .insert(enrolments)
        .values({
          id: deps.ids.id("enr"),
          serverId: null,
          mode: "claim_code",
          secretHash,
          presented: null,
          expiresAt: now + 10 * 60 * 1000,
          consumedAt: null,
          createdBy: JSON.stringify({ kind: "system", id: "claim-autocreate" }),
          createdAt: now,
        })
        // Two dials presenting the same brand-new code can both reach this insert; the
        // unique index on `secret_hash` plus this clause makes the loser a no-op instead of
        // a 500, and both then route to the same `claim:<hash>` DO regardless.
        .onConflictDoNothing({ target: enrolments.secretHash });
    }
    authKind = "enrolment";
    doName = `claim:${secretHash}`;
  }

  const stub = c.env.SERVER_DO.get(c.env.SERVER_DO.idFromName(doName));
  const headers = new Headers(c.req.raw.headers);
  // These are route-owned facts. Remove daemon-supplied values before conditionally setting
  // them, or an absent value would let an inbound internal header survive into the DO.
  headers.delete("x-cockpit-server-id");
  headers.delete("x-cockpit-observed-addr");
  headers.set("x-cockpit-auth-kind", authKind);
  headers.set("x-cockpit-secret-hash", secretHash);
  if (serverId) headers.set("x-cockpit-server-id", serverId);
  // The box's public egress address as the plane observed it. The daemon dials out and may
  // be behind NAT (ADR-0001), so anything it reported about its own interfaces would be a
  // claim, and possibly a private one. Absent under `wrangler dev` — then the address stays
  // null rather than becoming a guess.
  const observedAddr = c.req.header("cf-connecting-ip");
  if (observedAddr) headers.set("x-cockpit-observed-addr", observedAddr);

  return stub.fetch(new Request(c.req.raw, { headers }));
}
