import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// `npm run test:local-llm` — Candor against a REAL local language model server (llama.cpp + a small open model in
// .model-cache/llm). Slow (model load + CPU inference), so it is separate from the fast `npm test`.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@core': resolve(__dirname, 'src/core'),
      '@prompts': resolve(__dirname, 'src/prompts'),
    },
  },
  test: {
    include: ['tests/local-llm/**/*.test.ts'],
    environment: 'node',
    testTimeout: 600_000,
    hookTimeout: 240_000,
    pool: 'forks',
    fileParallelism: false,
  },
});
