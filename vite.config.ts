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
        // `woff2`/`woff` are here for the same offline reason as `wasm`: Quicksand
        // is self-hosted (never Google Fonts) so the app has no font dependency on
        // the network in a field with no bars.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest,wasm,woff2,woff}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
      manifest: {
        name: "Veteran's Carbon Holdings — Sampler",
        short_name: 'VCH Sampler',
        description: 'VCH soil sampling field capture',
        // Brand values, not invented ones: moss-900 is the darkest brand green and
        // sand-50 is the page ground on veteranscarbonholdings.com. The previous
        // `#0b3d2e` was a placeholder in neither brand scale.
        theme_color: '#132719',
        background_color: '#f8f3ea',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          // Android masks icons to a circle/squircle. Without a maskable variant
          // carrying its own safe zone, the logo's gold ring gets sliced.
          {
            src: '/icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
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
