import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(import.meta.dirname, "drizzle"));
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        // Test-only binding: `readD1Migrations` runs in Node (reads `drizzle/*.sql` off disk),
        // so migrations are handed to the Workers runtime this way, applied by
        // test/apply-migrations.ts (docs/workers/testing/vitest-integration/configuration).
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
