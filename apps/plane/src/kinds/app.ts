import { z } from "@hono/zod-openapi";

const EnvValueSchema = z.string();
const LimitsSchema = z.object({
  cpu: z.string().min(1),
  memory: z.string().min(1),
});

// The daemon wire type still accepts a narrower runtime spec. Extend it before deployment
// execution sends this saved configuration to the daemon.
export const AppConfigurationSchema = z.object({
  source: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("repo"),
      url: z.string().min(1),
      ref: z.string().min(1),
      path: z.string().min(1).optional(),
    }),
    z.object({
      type: z.literal("image"),
      image: z.string().min(1),
      digest: z.string().min(1).optional(),
    }),
  ]),
  build: z
    .object({
      dockerfile: z.string().min(1).optional(),
      args: z.record(z.string(), z.string()).optional(),
      limits: LimitsSchema,
      prune: z.object({ keep_layers: z.number().int().nonnegative() }),
    })
    .optional(),
  domains: z.array(z.string().min(1)),
  ports: z.array(
    z.object({
      container: z.number().int().positive(),
      protocol: z.enum(["tcp", "udp"]),
    }),
  ),
  env: z.record(z.string(), EnvValueSchema),
  replicas: z.number().int().positive(),
  healthcheck: z
    .object({
      path: z.string().min(1),
      interval_s: z.number().int().positive(),
      timeout_s: z.number().int().positive(),
      retries: z.number().int().nonnegative(),
    })
    .optional(),
  limits: LimitsSchema,
  restart: z.enum(["always", "unless-stopped", "on-failure"]),
});

export type AppConfiguration = z.infer<typeof AppConfigurationSchema>;
