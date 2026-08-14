import { createRoute } from "@hono/zod-openapi";
import type { AppRouteHandler } from "../app";
import { db, servers, enrolments, isUniqueConstraintError } from "../db";
import { CreateServerBody, CreateServerResponse } from "../schema";
import { issueToken, sha256Hex } from "../secrets";

export const createServerRoute = createRoute({
  method: "post",
  path: "/servers",
  request: { body: { content: { "application/json": { schema: CreateServerBody } } } },
  responses: {
    201: {
      description: "Server row created, enrolling; token and install command shown once",
      content: { "application/json": { schema: CreateServerResponse } },
    },
    409: { description: "A server with this name already exists" },
  },
});

const ENROLMENT_TTL_MS = 15 * 60 * 1000; // "minutes, not hours" — type-design §2.1.1

// /latest/ resolves to the newest release, so this URL never changes while the
// script and the digests it pins do.
const INSTALL_SCRIPT_URL =
  "https://github.com/oflabs44/cockpit/releases/latest/download/install.sh";

export const createServerHandler: AppRouteHandler<typeof createServerRoute> = async (c) => {
  const body = c.req.valid("json");
  const deps = c.var.deps;
  const now = deps.clock.now();
  const database = db(c.env.DB);

  const serverId = deps.ids.id("srv");
  try {
    await database.insert(servers).values({
      id: serverId,
      name: body.name,
      provider: body.provider,
      addr: null,
      arch: null,
      status: "enrolling",
      agentVersion: null,
      credentialHash: null,
      lastSeenAt: null,
      labels: JSON.stringify(body.labels),
      createdAt: now,
    });
  } catch (err) {
    if (isUniqueConstraintError(err, "servers.name")) return c.body(null, 409);
    throw err;
  }

  const token = issueToken(deps.ids);
  await database.insert(enrolments).values({
    id: deps.ids.id("enr"),
    serverId,
    mode: "token",
    secretHash: await sha256Hex(token),
    presented: null,
    expiresAt: now + ENROLMENT_TTL_MS,
    consumedAt: null,
    createdBy: JSON.stringify({ kind: "human", id: c.var.identity.email }),
    createdAt: now,
  });

  const planeUrl = new URL(c.req.url).origin;

  return c.json(
    {
      server: {
        id: serverId,
        name: body.name,
        provider: body.provider,
        addr: null,
        arch: null,
        status: "enrolling" as const,
        agent_version: null,
        last_seen_at: null,
        labels: body.labels,
        created_at: now,
      },
      token,
      install_command: `curl -fsSL ${INSTALL_SCRIPT_URL} | sh -s -- --plane ${planeUrl} --token ${token}`,
    },
    201,
  );
};
