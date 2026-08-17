/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: null,
      workbox: {
        // Media bytes and PMTiles route packs are managed by the app's own
        // OPFS storage, not the service worker precache -- see B1.
        //
        // `wasm` is here because the wa-sqlite binary (~1.1 MB) is what opens the
        // device database. Without it precached, a device that installs the PWA and
        // then has the browser evict the wasm from its ordinary HTTP cache cannot
        // open its database offline -- which negates B1's core promise that capture
        // never blocks on the network, and costs a sampling day in a build where a
        // defect found in October waits a year. `maximumFileSizeToCacheInBytes` is
        // already 5 MB, so the extension list was the only obstacle.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest,wasm}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
      manifest: {
        name: 'VCH Sampler',
        short_name: 'VCH Sampler',
        description: 'VCH soil sampling field capture',
        theme_color: '#0b3d2e',
        background_color: '#0b3d2e',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@shared': r('./src/shared'),
      '@sync': r('./src/sync'),
      '@server': r('./src/server'),
      '@app': r('./src/app'),
      '@ingest': r('./src/ingest'),
      '@analyst': r('./src/analyst'),
      '@fixtures': r('./fixtures'),
    },
  },
  server: {
    port: 5173,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.browser.test.ts', 'src/**/*.browser.test.tsx'],
  },
});
