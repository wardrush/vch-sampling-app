/**
 * B1 — proves the device-DB bootstrap orchestration end to end, against real
 * SQLite (Node's built-in `node:sqlite`, `tests/support/node-sqlite.ts`), not
 * a hand-rolled fake. This is the honest boundary described in
 * `wa-sqlite-opfs.ts`'s header: the migration logic is fully covered here;
 * the OPFS/wa-sqlite transport it runs over in a real browser is not, and
 * cannot be from this sandbox.
 */

import { describe, expect, it } from 'vitest';
import { NodeSqliteDb } from '../../../../tests/support/node-sqlite.js';
import { openDeviceDb, _resetDeviceDbForTests, getDeviceDb } from './device-db.js';
import { TARGET_SCHEMA_VERSION } from '../../../shared/db/schema.js';

describe('openDeviceDb', () => {
  it('migrates a fresh connection to the target schema version', async () => {
    const { db, migration } = await openDeviceDb({
      createConnection: async () => new NodeSqliteDb(':memory:'),
    });

    expect(migration.from).toBe(0);
    expect(migration.to).toBe(TARGET_SCHEMA_VERSION);
    expect(migration.applied).toEqual(['device_v01', 'device_v02_addendum']);

    // The outbox table (A3, src/sync/outbox-store.ts) is what every screen
    // this wave placeholders for will actually read from — prove it exists
    // and is queryable through the same `SqlDatabase` surface the app uses.
    const rows = await db.all<{ n: number }>('SELECT COUNT(*) AS n FROM outbox');
    expect(rows[0]?.n).toBe(0);
  });

  it('is idempotent — a second bootstrap of the same connection applies nothing new', async () => {
    const conn = new NodeSqliteDb(':memory:');
    const first = await openDeviceDb({ createConnection: async () => conn });
    expect(first.migration.applied.length).toBeGreaterThan(0);

    const second = await openDeviceDb({ createConnection: async () => conn });
    expect(second.migration.from).toBe(TARGET_SCHEMA_VERSION);
    expect(second.migration.applied).toEqual([]);
  });
});

describe('getDeviceDb', () => {
  it('memoises — two calls without a reset return the same handle', async () => {
    _resetDeviceDbForTests();
    // getDeviceDb() defaults to the real wa-sqlite/OPFS driver, which throws
    // outside a browser (by design — see wa-sqlite-opfs.ts). This test only
    // proves the singleton *caches the promise*, not what it resolves to.
    const first = getDeviceDb();
    const second = getDeviceDb();
    expect(first).toBe(second);
    await expect(first).rejects.toThrow(/OPFS/);
    _resetDeviceDbForTests();
  });
});
