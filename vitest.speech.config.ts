import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// `npm run test:speech` runs the real on-device speech engine on real audio; `npm run bench:stt` measures its latency
// and CPU on this machine. Both load models of hundreds of megabytes, so they are separate from the fast `npm test`.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@core': resolve(__dirname, 'src/core'),
      '@prompts': resolve(__dirname, 'src/prompts'),
    },
  },
  test: {
    include: ['tests/speech/**/*.{test,bench}.ts'],
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 180_000,
    pool: 'forks',
    // One process, one file at a time: concurrent model loads would distort the timings and exhaust memory.
    fileParallelism: false,
  },
});
