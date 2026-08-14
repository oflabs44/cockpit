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
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Every operator route now refuses to serve without these (src/access.ts), and
            // tests pass `env` straight through to `app.fetch`. The tokens themselves are
            // signed per test by test/access.ts — this only tells the middleware which
            // issuer and audience to accept.
            ACCESS_TEAM_DOMAIN: "cockpit-test.cloudflareaccess.com",
            ACCESS_AUD: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
