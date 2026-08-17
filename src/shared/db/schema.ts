/**
 * F0.6 — device SQLite bootstrap and migration runner.
 *
 * **Both Lane B and Lane C read local state through this.** Nothing else opens
 * the database or issues DDL.
 *
 * Two properties are worth stating because they are the ones an app that ships
 * to phones needs and rarely gets:
 *
 *  1. **Migrations are forward-only and additive.** SQLite supports
 *     `ADD COLUMN` and little else, which is also the right constraint for a
 *     fleet where a device may be a version behind and holding a week of
 *     unsynced work. There is no `down`, deliberately: a rollback on a device
 *     carrying uncommitted samples destroys the samples.
 *  2. **The runner is idempotent via `PRAGMA user_version`**, not via
 *     `IF NOT EXISTS`. The v02 `ALTER TABLE`s cannot be re-run, so the version
 *     gate is what makes a second call to `migrate()` a no-op.
 */

import type { SqlDatabase } from './types.js';
import { DEVICE_SCHEMA_V01 } from './migrations/001_device_v01.js';
import { DEVICE_SCHEMA_V02 } from './migrations/002_device_v02.js';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Ordered, append-only. Never renumber, never edit a shipped entry. */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'device_v01', sql: DEVICE_SCHEMA_V01 },
  { version: 2, name: 'device_v02_addendum', sql: DEVICE_SCHEMA_V02 },
];

export const TARGET_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export async function getSchemaVersion(db: SqlDatabase): Promise<number> {
  const rows = await db.all<{ user_version: number }>('PRAGMA user_version');
  return Number(rows[0]?.user_version ?? 0);
}

export interface MigrateResult {
  from: number;
  to: number;
  applied: string[];
}

/**
 * Brings the database to `TARGET_SCHEMA_VERSION`.
 *
 * Each migration runs inside its own transaction, so a failure part-way leaves
 * the database at the last good version rather than half-migrated. A device
 * that fails to migrate still has its unsynced work, which is the outcome that
 * matters.
 */
export async function migrate(db: SqlDatabase): Promise<MigrateResult> {
  const from = await getSchemaVersion(db);
  const applied: string[] = [];

  if (from > TARGET_SCHEMA_VERSION) {
    // A device that has seen a newer app version than the one now running.
    // Refuse rather than guess: downgrading the schema loses columns holding
    // captured work.
    throw new Error(
      `device schema v${from} is newer than this build (v${TARGET_SCHEMA_VERSION}); refusing to downgrade`,
    );
  }

  for (const m of MIGRATIONS) {
    if (m.version <= from) continue;
    await db.exec('BEGIN IMMEDIATE');
    try {
      await db.exec(m.sql);
      // PRAGMA does not accept a bound parameter; the value is an integer
      // literal from a const array, never user input.
      await db.exec(`PRAGMA user_version = ${m.version}`);
      await db.exec('COMMIT');
    } catch (err) {
      try {
        await db.exec('ROLLBACK');
      } catch {
        /* connection already unusable; surface the original */
      }
      throw new Error(`migration ${m.version} (${m.name}) failed: ${String(err)}`, {
        cause: err,
      });
    }
    applied.push(m.name);
  }

  return { from, to: await getSchemaVersion(db), applied };
}

/**
 * Opens the device database for use: connection pragmas first, then migrate.
 *
 * `journal_mode = WAL` and `foreign_keys = ON` are connection-scoped and must
 * run outside a transaction — which is why they live here and not in the v01
 * migration text.
 */
export async function bootstrapDeviceDb(db: SqlDatabase): Promise<MigrateResult> {
  await db.exec('PRAGMA journal_mode = WAL');
  await db.exec('PRAGMA foreign_keys = ON');
  return migrate(db);
}

/**
 * Wipes the read-only half of the device schema so a bundle can be applied.
 *
 * **Replace, never patch** (contract §2). A corrupt local ref table is fixed by
 * re-downloading, not by debugging a merge. Nothing write-local is touched —
 * the caller's boundary here is the difference between a stale contact list
 * and a lost day's samples.
 */
export const BUNDLE_REPLACED_TABLES = [
  'ref_condition_code',
  'ref_deviation_reason',
  'ref_defect_code',
  'ref_lab',
  'project_sampling_spec',
  'access_contact',
  'sample_plan_point',
  'assigned_boundary',
] as const;

export async function clearBundleTables(db: SqlDatabase): Promise<void> {
  // Child-before-parent order; `access_contact` and `sample_plan_point` both
  // reference `assigned_boundary`.
  for (const table of BUNDLE_REPLACED_TABLES) {
    await db.run(`DELETE FROM ${table}`);
  }
}
