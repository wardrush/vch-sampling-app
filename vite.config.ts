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
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
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
