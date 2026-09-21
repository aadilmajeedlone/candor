import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const alias = {
  '@shared': resolve(__dirname, 'src/shared'),
  '@core': resolve(__dirname, 'src/core'),
  '@prompts': resolve(__dirname, 'src/prompts'),
};

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      outDir: 'out/main',
      sourcemap: true,
      rollupOptions: {
        // Speech recognition runs in a worker thread, which needs its own script file (see src/main/stt/local/spawn.ts).
        input: { index: resolve(__dirname, 'src/main/index.ts'), sttWorker: resolve(__dirname, 'src/main/stt/local/worker.ts') },
        output: { entryFileNames: '[name].js' },
      },
    },
  },
  preload: {
    resolve: { alias },
    build: {
      outDir: 'out/preload',
    },
  },
  renderer: {
    root: 'src/renderer',
    resolve: { alias: { ...alias, '@': resolve(__dirname, 'src/renderer/src') } },
    plugins: [react()],
    build: {
      outDir: 'out/renderer',
      sourcemap: false,
      // The audio worklet must be a real file: a data: URI would be blocked by the strict CSP.
      assetsInlineLimit: 0,
    },
  },
});
