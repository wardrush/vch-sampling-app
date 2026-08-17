/**
 * B1 — device database bootstrap, the module every screen (this wave and the
 * next) reads local state through.
 *
 * Two things are deliberately separate so each can be tested for what it
 * actually is:
 *
 *  - **`openDeviceDb()`** is pure orchestration — open a connection, run
 *    `bootstrapDeviceDb()` (F0.6, `src/shared/db/schema.ts`), return the
 *    handle. It takes its connection factory as a parameter so
 *    `device-db.test.ts` can inject `tests/support/node-sqlite.ts`'s real
 *    Node-SQLite fake and prove the migration runs end-to-end, without a
 *    browser.
 *  - **`getDeviceDb()`** is the memoised singleton the app actually calls,
 *    defaulting to the real `wa-sqlite`/OPFS driver. This is genuinely
 *    browser-only — see `wa-sqlite-opfs.ts`'s header for why that can't be
 *    exercised under `npm test`.
 */

import type { SqlDatabase } from '../../../shared/db/types.js';
import { bootstrapDeviceDb, type MigrateResult } from '../../../shared/db/schema.js';
import { openWaSqliteOpfsDatabase } from './wa-sqlite-opfs.js';

export interface DeviceDbHandle {
  db: SqlDatabase;
  migration: MigrateResult;
}

export interface OpenDeviceDbOptions {
  /** Defaults to the real wa-sqlite/OPFS driver. Overridable for tests. */
  createConnection?: () => Promise<SqlDatabase>;
}

/**
 * Opens a connection and brings it to `TARGET_SCHEMA_VERSION`.
 *
 * Does not cache — callers that want the app-wide singleton use
 * `getDeviceDb()`. A test that wants a fresh database per case calls this
 * directly with its own `createConnection`.
 */
export async function openDeviceDb(options: OpenDeviceDbOptions = {}): Promise<DeviceDbHandle> {
  const createConnection = options.createConnection ?? (() => openWaSqliteOpfsDatabase());
  const db = await createConnection();
  const migration = await bootstrapDeviceDb(db);
  return { db, migration };
}

let singleton: Promise<DeviceDbHandle> | null = null;

/**
 * The one device database connection for the app's lifetime.
 *
 * Memoised deliberately: every screen that needs local data calls this, and a
 * second OPFS connection racing the first's migration transaction is exactly
 * the kind of bug that only shows up on a phone, at a field, mid-season.
 */
export function getDeviceDb(): Promise<DeviceDbHandle> {
  if (!singleton) {
    singleton = openDeviceDb().catch((err) => {
      singleton = null;
      throw err;
    });
  }
  return singleton;
}

/** Test-only: forces the next `getDeviceDb()` to open a fresh connection. */
export function _resetDeviceDbForTests(): void {
  singleton = null;
}
