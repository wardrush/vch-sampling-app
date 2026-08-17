/**
 * Real-browser verification. Build plumbing, so orchestrator-owned.
 *
 * This exists because of a specific failure. The device database is
 * `wa-sqlite` over a browser storage VFS, and **nothing under `npm test` can
 * execute it** — jsdom has no `navigator.storage`, no IndexedDB worth the
 * name, and no wasm host that behaves like a browser's. So the driver shipped
 * to production having never once run, and it failed on the first real device
 * with `unable to open database file`: the VFS in use called
 * `createSyncAccessHandle`, which exists only on a Worker thread.
 *
 * A unit test could not have caught that, and no amount of care in review
 * would have either. Only a real browser can. That is what this config is for.
 *
 * `webServer` builds and serves the production bundle rather than the dev
 * server on purpose: the bug was in shipped output, and `vite dev` also has no
 * functions runtime, so `MOCK_SNOWFLAKE=1`'s fixture path is what gets
 * exercised either way.
 */

import { defineConfig, devices } from '@playwright/test';

// The image ships a Chromium that predates the pinned @playwright/test, so the
// bundled resolver looks for a build number that is not here. Point at the real
// binary instead of downloading a second one; `undefined` falls back to
// Playwright's own lookup wherever that is correct (a developer laptop, CI).
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: './tests/e2e',
  // The database work is genuinely slow the first time: wasm instantiation plus
  // a migration run. A tight timeout here reads as a flake and gets "fixed" by
  // retrying, which is how a real regression becomes invisible.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], launchOptions: { executablePath } },
    },
    {
      // The crew is on phones. A layout that only works at 1280px wide is not
      // the product, and touch targets are a v02 §4.3 requirement.
      name: 'android-viewport',
      use: { ...devices['Pixel 7'], launchOptions: { executablePath } },
    },
  ],
  webServer: {
    command: 'npm run build && npx vite preview --port 4173 --host 127.0.0.1',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { MOCK_SNOWFLAKE: '1' },
  },
});
