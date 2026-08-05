import { createRoute, z } from "@hono/zod-openapi";
import type { AppRouteHandler } from "../app";

export const healthRoute = createRoute({
  method: "get",
  path: "/health",
  responses: {
    200: {
      description: "Proof of life",
      content: {
        "application/json": {
          schema: z.object({ status: z.literal("ok") }),
        },
      },
    },
  },
});

export const healthHandler: AppRouteHandler<typeof healthRoute> = (c) =>
  c.json({ status: "ok" as const });
