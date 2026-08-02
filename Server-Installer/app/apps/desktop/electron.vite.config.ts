import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    // Bundle the shared workspace packages AND `ws` into the main bundle.
    // Electron's Node 20 ESM loader hits a CJS-preparse crash when externalizing
    // these as runtime ESM imports; bundling eliminates the runtime resolution.
    // `electron` (a built-in) and native addons (koffi via createRequire; ws's
    // optional bufferutil/utf-8-validate) stay external.
    plugins: [externalizeDepsPlugin({ exclude: ['@mun/protocol', '@mun/crypto', 'ws'] })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        external: ['bufferutil', 'utf-8-validate', 'koffi'],
      },
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') },
    },
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
    plugins: [react()],
  },
});
