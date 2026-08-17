import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@shared': r('./src/shared'),
      '@sync': r('./src/sync'),
      '@server': r('./src/server'),
      '@app': r('./src/app'),
      '@ingest': r('./src/ingest'),
      '@fixtures': r('./fixtures'),
    },
  },
});
