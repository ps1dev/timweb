/// <reference types="vitest" />
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * Builds to ONE self-contained index.html: no external JS, no external CSS,
 * no fetches at runtime. Copy it anywhere, open it offline, it works.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
  base: './',
  plugins: [viteSingleFile()],
  build: {
    target: 'es2022',
    assetsInlineLimit: 100 * 1024 * 1024,
    cssCodeSplit: false,
    reportCompressedSize: true,
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
