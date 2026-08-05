import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";

const testEnv = env as typeof env & { TEST_MIGRATIONS: D1Migration[] };

await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
