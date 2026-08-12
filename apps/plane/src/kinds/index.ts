import { z } from "@hono/zod-openapi";
import { AppConfigurationSchema } from "./app";

export interface KindEntry {
  configurationSchema: z.ZodType;
  configurationVersion: number;
}

const permissiveConfiguration = z.record(z.string(), z.unknown());
const stub = (): KindEntry => ({
  configurationSchema: permissiveConfiguration,
  configurationVersion: 1,
});

export const KINDS: Record<string, KindEntry> = {
  app: {
    configurationSchema: AppConfigurationSchema,
    configurationVersion: 1,
  },
  database: stub(),
  proxy: stub(),
  volume: stub(),
  network: stub(),
  cron: stub(),
  daemon: stub(),
  firewall_rule: stub(),
};

export function kindEntry(kind: string): KindEntry | undefined {

  return Object.hasOwn(KINDS, kind) ? KINDS[kind] : undefined;
}
