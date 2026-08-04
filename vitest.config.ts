import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The offline model and the fixture server are both deterministic, so the
    // suite can run in parallel without flakiness.
    environment: 'node',
  },
});
