import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, isNull } from "drizzle-orm";
import type { AppRouteHandler } from "../app";
import { db, enrolments, servers, isUniqueConstraintError } from "../db";
import { RedeemResponse } from "../schema";
import { issueCredential, sha256Hex } from "../secrets";
import { REDEEM_LIMITS, withinRateLimit } from "../rate-limit";
import { safeJsonParse } from "../json";

const RedeemBody = z
  .object({
    server_id: z.string().optional(), // bind to an existing (pre-created) server
    name: z.string().optional(), // or create one, operator naming the box on redeem
    provider: z.enum(["hetzner", "digitalocean", "linode", "other"]).optional(),
  })
  .refine((b) => b.server_id || (b.name && b.provider), {
    message: "either server_id, or both name and provider, are required",
  });

export const redeemEnrolmentRoute = createRoute({
  method: "post",
  path: "/enrolments/{code}/redeem",
  request: {
    params: z.object({ code: z.string() }),
    body: { content: { "application/json": { schema: RedeemBody } } },
  },
  responses: {
    200: {
      description: "Claim bound; the pending daemon connection was sent its credential",
      content: { "application/json": { schema: RedeemResponse } },
    },
    404: { description: "No such pending claim code" },
    409: {
      description:
        "No daemon is currently holding this claim code's socket (delivery failed — the code " +
        "is NOT consumed, retry once the daemon connects), or the server name is already taken",
    },
    429: { description: "Rate limited" },
  },
});

export const redeemEnrolmentHandler: AppRouteHandler<typeof redeemEnrolmentRoute> = async (c) => {
  const { code } = c.req.valid("param");
  const body = c.req.valid("json");
  const deps = c.var.deps;
  const database = db(c.env.DB);
  const now = deps.clock.now();

  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (!(await withinRateLimit(c.env.SERVER_DO, now, ip, REDEEM_LIMITS))) return c.body(null, 429);

  const secretHash = await sha256Hex(code);
  const enrolment = await database
    .select()
    .from(enrolments)
    .where(and(eq(enrolments.secretHash, secretHash), eq(enrolments.mode, "claim_code")))
    .get();
  if (!enrolment || enrolment.consumedAt || enrolment.expiresAt <= now) return c.body(null, 404);

  // The daemon's `hello` already told us this before redeem ever ran (ServerDO#handleHello
  // stores it on the pending claim connection, since there's no server row yet to write it
  // onto) — a newly-created server would otherwise start its first session with these null.
  const presented = safeJsonParse<{ arch?: string; agent_version?: string } | null>(
    enrolment.presented ?? "null",
    null,
    `enrolments.presented (${enrolment.id})`,
  );
  const presentedArch = presented?.arch || null; // clampField turns "missing" into "", not absent
  const presentedAgentVersion = presented?.agent_version || null;

  // Fields for the response, filled in by whichever branch below runs — kept in hand so the
  // final response doesn't depend on a re-SELECT after the writes (finding #8: a successful
  // exchange must not be reported as a 404 because of an unrelated read race).
  let serverFields: {
    id: string;
    name: string;
    provider: string;
    addr: string | null;
    arch: string | null;
    agentVersion: string | null;
    labels: string;
    createdAt: number;
  };

  if (body.server_id) {
    const existing = await database.select().from(servers).where(eq(servers.id, body.server_id)).get();
    if (!existing) return c.body(null, 404);
    serverFields = existing;
  } else {
    const serverId = deps.ids.id("srv");
    try {
      await database.insert(servers).values({
        id: serverId,
        name: body.name as string,
        provider: body.provider as string,
        addr: null,
        arch: presentedArch,
        status: "enrolling",
        agentVersion: presentedAgentVersion,
        credentialHash: null,
        lastSeenAt: null,
        labels: "{}",
        createdAt: now,
      });
    } catch (err) {
      if (isUniqueConstraintError(err, "servers.name")) return c.body(null, 409);
      throw err;
    }
    serverFields = {
      id: serverId,
      name: body.name as string,
      provider: body.provider as string,
      addr: null,
      arch: presentedArch,
      agentVersion: presentedAgentVersion,
      labels: "{}",
      createdAt: now,
    };
  }

  const credential = issueCredential(deps.ids);
  const credentialHash = await sha256Hex(credential);
  await database.update(servers).set({ credentialHash }).where(eq(servers.id, serverFields.id));

  // Deliver before burning (finding #3): if nothing is actually holding the claim socket, the
  // code must stay redeemable rather than being spent on a delivery that never happened.
  const pending = c.env.SERVER_DO.get(c.env.SERVER_DO.idFromName(`claim:${secretHash}`));
  const { delivered } = await pending.redeemBind(now, serverFields.id, credential);
  if (delivered < 1) return c.body(null, 409);

  const burned = await database
    .update(enrolments)
    .set({ consumedAt: now, serverId: serverFields.id })
    .where(and(eq(enrolments.id, enrolment.id), isNull(enrolments.consumedAt)))
    .run();
  if (burned.meta.changes === 0) {
    // `redeemBind`'s own `boundServerId` guard already makes double-delivery essentially
    // impossible, but if this ever races, the credential was still just delivered above — log
    // it as a correctness concern rather than silently reporting the redeem as a 404.
    console.error("claim code redeemed but consumed_at update lost a race", { enrolmentId: enrolment.id });
  }

  return c.json({
    server: {
      id: serverFields.id,
      name: serverFields.name,
      provider: serverFields.provider as "hetzner" | "digitalocean" | "linode" | "other",
      addr: serverFields.addr,
      arch: serverFields.arch,
      status: "connected" as const, // redeemBind's #setConnected just wrote this
      agent_version: serverFields.agentVersion,
      last_seen_at: now,
      labels: safeJsonParse(serverFields.labels, {}, `servers.labels (${serverFields.id})`),
      created_at: serverFields.createdAt,
    },
  });
};
