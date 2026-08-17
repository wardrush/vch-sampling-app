/**
 * B1 — smoke test for the real OPFS/wa-sqlite driver.
 *
 * Runs under `npm run test:browser` (jsdom, per `vite.config.ts`). jsdom does
 * not implement `navigator.storage.getDirectory()` — no headless Chromium is
 * available in this build sandbox either (checked: no `playwright`/`puppeteer`
 * in `node_modules`, no system Chrome) — so this **skips itself** rather than
 * claiming coverage it cannot back up. v02 §11's "no test that claims to
 * cover a hardware criterion" is about items 6/7, but the same honesty
 * applies here: this file exists so the assertion runs the moment it *can*
 * (any real Chromium/Edge/WebView — CI with `--browser=chromium`, or a
 * developer's own machine), and says so explicitly rather than silently
 * passing on a fake positive.
 */

import { describe, expect, it } from 'vitest';
import { openWaSqliteOpfsDatabase, _resetConnectionForTests } from './wa-sqlite-opfs.js';

const hasOpfs =
  typeof navigator !== 'undefined' &&
  typeof navigator.storage !== 'undefined' &&
  typeof navigator.storage.getDirectory === 'function';

describe.skipIf(!hasOpfs)('openWaSqliteOpfsDatabase (real OPFS only)', () => {
  it('opens a connection and runs SQL', async () => {
    _resetConnectionForTests();
    const db = await openWaSqliteOpfsDatabase(`test-${Date.now()}.sqlite3`);
    await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT)');
    await db.run('INSERT INTO t (label) VALUES (?)', ['hello']);
    const rows = await db.all<{ id: number; label: string }>('SELECT * FROM t');
    expect(rows).toEqual([{ id: 1, label: 'hello' }]);
  });
});

describe('openWaSqliteOpfsDatabase (this environment)', () => {
  it('documents whether OPFS was available when this suite last ran', () => {
    // Always runs, always green — a record of what was actually exercised,
    // not a claim either way about the driver's correctness.
    // eslint-disable-next-line no-console
    console.info(`OPFS available in this test environment: ${hasOpfs}`);
    expect(typeof hasOpfs).toBe('boolean');
  });
});
