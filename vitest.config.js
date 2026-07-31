import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

// Worker route tests run against a real (isolated, in-test) D1 with the actual
// migration chain applied — the same SQL production runs.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.test.toml' },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    test: {
      include: ['test/worker/**/*.spec.js'],
      setupFiles: ['./test/worker/apply-migrations.js'],
    },
  };
});
