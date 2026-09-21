import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// `npm run bench` — measures the local (non-network) parts of the latency pipeline on this machine.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@core': resolve(__dirname, 'src/core'),
      '@prompts': resolve(__dirname, 'src/prompts'),
    },
  },
  test: {
    include: ['tests/bench/**/*.bench.ts'],
    environment: 'node',
    testTimeout: 120_000,
    pool: 'forks',
    // One process, no parallel files: concurrent workers would distort the timings.
    fileParallelism: false,
  },
});
