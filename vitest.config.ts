import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // `.test.tsx` is included deliberately. Wave 1's integration gate found that
    // omitting it made a React component test *silently uncollected* -- vitest
    // reports success for files it never ran, so an agent would see green over
    // tests that never executed. Wave 2 writes the six screens; that trap had to
    // close before it sprang. See `.claude/fleet/reports/wave-1-integration.md` 4.4.
    include: ['tests/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    // Component tests need a DOM; everything else stays on `node`, which is
    // faster and keeps the sync/server suites honest about not touching a DOM.
    environmentMatchGlobs: [['**/*.test.tsx', 'jsdom']],
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
