import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/cli/**', 'src/types/**'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
    // Integration tests need more time for devnet RPC calls
    testTimeout: 90_000,
    hookTimeout: 30_000,
    // Separate pools for unit vs integration to avoid cross-contamination
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
  },
});
