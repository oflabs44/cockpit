import type { Bindings } from "./app";

// docs/type-design.md §2.1.1: claim codes are "additionally rate-limited by IP and globally,
// being short enough to guess." Applied to both claim-mode `/daemon` connects (each one a D1
// insert + a DO) and `POST /enrolments/:code/redeem` attempts. Reuses the one `SERVER_DO`
// binding as a plain fixed-window counter, addressed `rl:<category>:<ip>` / `rl:<category>:global`
// — see the `ServerDO` class comment. The category keeps the two call sites' buckets from
// sharing a counter with each other.
export const CLAIM_CONNECT_LIMITS = {
  category: "claim-connect",
  perIp: { max: 5, windowMs: 60_000 },
  global: { max: 30, windowMs: 60_000 },
};

export const REDEEM_LIMITS = {
  category: "redeem",
  perIp: { max: 5, windowMs: 60_000 },
  global: { max: 30, windowMs: 60_000 },
};

export async function withinRateLimit(
  serverDo: Bindings["SERVER_DO"],
  now: number,
  ip: string,
  limits: typeof CLAIM_CONNECT_LIMITS,
): Promise<boolean> {
  const perIp = serverDo.get(serverDo.idFromName(`rl:${limits.category}:${ip}`));
  const global = serverDo.get(serverDo.idFromName(`rl:${limits.category}:global`));
  const [ipOk, globalOk] = await Promise.all([
    perIp.checkRateLimit(now, limits.perIp.max, limits.perIp.windowMs),
    global.checkRateLimit(now, limits.global.max, limits.global.windowMs),
  ]);
  return ipOk && globalOk;
}
