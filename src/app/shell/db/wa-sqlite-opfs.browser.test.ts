/**
 * B1 — smoke test for the real wa-sqlite driver.
 *
 * Runs under `npm run test:browser` (jsdom, per `vite.config.ts`). jsdom has
 * no `indexedDB` (checked directly: `'indexedDB' in new JSDOM().window` is
 * `false`) and no wasm host that behaves like a browser's — the wasm loader
 * calls `fetch()` on a `file://` module URL, which Node's `fetch` refuses —
 * so this **skips itself** rather than claiming coverage it cannot back up.
 * v02 §11's "no test that claims to cover a hardware criterion" is about
 * items 6/7, but the same honesty applies here: this file exists so the
 * assertion runs the moment it *can* (any real browser), and says so
 * explicitly rather than silently passing on a fake positive. The real
 * verification — that the driver opens for real, with the fallback and the
 * "Device database unavailable" banner genuinely absent — lives in
 * `tests/e2e/**` (Playwright, a real Chromium).
 */

import { describe, expect, it } from 'vitest';
import { openWaSqliteOpfsDatabase, _resetConnectionForTests } from './wa-sqlite-opfs.js';

const hasIndexedDb = typeof indexedDB !== 'undefined';

describe.skipIf(!hasIndexedDb)('openWaSqliteOpfsDatabase (real IndexedDB only)', () => {
  it('opens a connection backed by IndexedDB and runs SQL', async () => {
    _resetConnectionForTests();
    const db = await openWaSqliteOpfsDatabase(`test-${Date.now()}.sqlite3`);
    await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT)');
    await db.run('INSERT INTO t (label) VALUES (?)', ['hello']);
    const rows = await db.all<{ id: number; label: string }>('SELECT * FROM t');
    expect(rows).toEqual([{ id: 1, label: 'hello' }]);
  });
});

describe('openWaSqliteOpfsDatabase (this environment)', () => {
  it('documents whether IndexedDB was available when this suite last ran', () => {
    // Always runs, always green — a record of what was actually exercised,
    // not a claim either way about the driver's correctness.
    // eslint-disable-next-line no-console
    console.info(`IndexedDB available in this test environment: ${hasIndexedDb}`);
    expect(typeof hasIndexedDb).toBe('boolean');
  });
});
