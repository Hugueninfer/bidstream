import { defineConfig } from 'vitest/config';

// Integration tests talk to the Postgres started by docker compose.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Test files share one database; run them one after another.
    fileParallelism: false,
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ?? 'postgresql://bidstream:bidstream@localhost:55432/bid',
    },
  },
});
