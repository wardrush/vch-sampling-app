/**
 * The Postgres migration runner — idempotent, lockable, safe on every deploy.
 *
 * The Netlify database exists and is empty. The intended wiring is that the
 * build calls this, so a deploy converges the schema with zero manual steps and
 * a fresh database self-provisions on first deploy.
 *
 * ## Four properties, and why each one is here
 *
 * **1 · Every statement is idempotent.** The DDL is `CREATE … IF NOT EXISTS`,
 * `CREATE INDEX IF NOT EXISTS`, `CREATE OR REPLACE VIEW`, guarded `ALTER`s and
 * guarded seeds. Running it twice is indistinguishable from running it once,
 * which is the property you want at the moment a deploy has just failed halfway.
 *
 * **2 · One transaction, with `pg_advisory_xact_lock` as its first statement.**
 * Two deploys or two cold starts can race, and the second must wait rather than
 * half-apply alongside the first.
 *
 * The *transactional* advisory lock is the right variant, not an approximation:
 * Neon's HTTP driver is stateless, so a session-scoped `pg_advisory_lock` would
 * be released the instant its one-query HTTP session ended, which is a lock that
 * looks like a lock and holds nothing. `pg_advisory_xact_lock` is held for the
 * transaction, and the transaction here is the whole migration. Postgres DDL is
 * transactional, so this also buys atomicity: a failure rolls the schema back
 * rather than leaving half of it.
 *
 * **3 · What was applied is recorded**, in `META.SCHEMA_MIGRATION`, keyed by
 * file with its content hash. A file whose hash changed is re-applied — correct
 * for additive idempotent DDL, and it means adding a column is a deploy rather
 * than a ceremony. The hash is also the drift detector: a *non*-additive edit to
 * an applied file shows up as a re-apply of a changed file in the log, which is
 * the point at which someone should notice.
 *
 * **4 · Forward-only.** No down path, matching the device runner
 * (`./schema.ts`). Field devices go a week between syncs and cannot be rolled
 * back to; a warehouse with a week of their work in it is no different.
 *
 * ## Honest limits
 *
 * The pending set is computed *before* the lock is taken, because the HTTP
 * driver's transactions are non-interactive — you submit a fixed list of
 * statements, you cannot branch mid-transaction. So a runner that loses the race
 * re-executes idempotent DDL rather than skipping it. That is harmless by
 * property 1, and the run-id stamp means it still *reports* the truth: it says
 * it applied nothing, because it did not write the rows.
 */

import { createHash } from 'node:crypto';
import type { PgExecutor, PgQuery } from './postgres/client.js';
import { toPostgresError } from './postgres/client.js';
import { splitStatements } from './sql-statements.js';

/**
 * The advisory-lock key. Arbitrary but **fixed** — every runner against this
 * database must use the same pair or the lock does not serialise anything.
 * (`0x5643`, `0x4744`) is `"VC"`,`"GD"`.
 */
export const MIGRATION_LOCK_KEYS: readonly [number, number] = [0x5643, 0x4744];

export const MIGRATION_TABLE = 'META.SCHEMA_MIGRATION';

/**
 * Bootstrap, run before the lock and outside the migration transaction.
 *
 * The runner cannot read "what is applied" until this exists, so it cannot live
 * in the migration file it would be gating. Both statements are idempotent and
 * harmless to race.
 */
export const BOOTSTRAP_STATEMENTS: readonly string[] = [
  `CREATE SCHEMA IF NOT EXISTS META`,
  `CREATE TABLE IF NOT EXISTS META.SCHEMA_MIGRATION (
     MIGRATION_ID      text        NOT NULL PRIMARY KEY,
     CONTENT_SHA256    text        NOT NULL,
     STATEMENT_COUNT   integer     NOT NULL,
     FIRST_APPLIED_TS  timestamptz NOT NULL DEFAULT now(),
     APPLIED_TS        timestamptz NOT NULL DEFAULT now(),
     APPLIED_RUN_ID    text        NOT NULL,
     APPLY_COUNT       integer     NOT NULL DEFAULT 1
   )`,
];

export interface MigrationFile {
  /** Stable identity. The filename — never renamed, never renumbered. */
  id: string;
  sql: string;
}

export interface PlannedMigration {
  id: string;
  sha256: string;
  statements: string[];
  /** Why it is in the plan: never seen, or seen with different content. */
  reason: 'new' | 'content_changed';
  previousSha256?: string;
}

export interface MigrationPlan {
  runId: string;
  pending: PlannedMigration[];
  alreadyApplied: string[];
}

export interface MigrationOutcome extends MigrationPlan {
  /** Ids this run actually wrote the ledger row for. Empty when a racer won. */
  applied: string[];
  statementsExecuted: number;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Reads a `.sql` file into a plan entry. Pure — no I/O, no connection. */
export function planFile(file: MigrationFile): Omit<PlannedMigration, 'reason'> {
  return {
    id: file.id,
    sha256: sha256Hex(file.sql),
    statements: splitStatements(file.sql),
  };
}

/**
 * What the runner *would* do, given the ledger. Pure, so `--dry-run` reports the
 * same plan the live path would execute rather than a separate approximation.
 */
export function buildPlan(
  files: readonly MigrationFile[],
  ledger: ReadonlyMap<string, string>,
  runId: string,
): MigrationPlan {
  const pending: PlannedMigration[] = [];
  const alreadyApplied: string[] = [];

  for (const file of files) {
    const planned = planFile(file);
    const recorded = ledger.get(file.id);
    if (recorded === planned.sha256) {
      alreadyApplied.push(file.id);
      continue;
    }
    pending.push({
      ...planned,
      reason: recorded === undefined ? 'new' : 'content_changed',
      ...(recorded === undefined ? {} : { previousSha256: recorded }),
    });
  }

  return { runId, pending, alreadyApplied };
}

/**
 * The statement list for the migration transaction, lock first.
 *
 * Exported so `--dry-run` can print the exact list, including the lock and the
 * ledger writes, rather than a summary of it.
 */
export function buildMigrationQueries(plan: MigrationPlan): PgQuery[] {
  const queries: PgQuery[] = [
    {
      sql: `SELECT pg_advisory_xact_lock($1, $2)`,
      params: [MIGRATION_LOCK_KEYS[0], MIGRATION_LOCK_KEYS[1]],
    },
  ];

  for (const migration of plan.pending) {
    for (const statement of migration.statements) {
      queries.push({ sql: statement, params: [] });
    }
    queries.push({
      sql: `INSERT INTO ${MIGRATION_TABLE}
              (MIGRATION_ID, CONTENT_SHA256, STATEMENT_COUNT, APPLIED_RUN_ID)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (MIGRATION_ID) DO UPDATE SET
              CONTENT_SHA256 = EXCLUDED.CONTENT_SHA256,
              STATEMENT_COUNT = EXCLUDED.STATEMENT_COUNT,
              APPLIED_TS = now(),
              APPLIED_RUN_ID = EXCLUDED.APPLIED_RUN_ID,
              APPLY_COUNT = ${MIGRATION_TABLE}.APPLY_COUNT + 1`,
      params: [migration.id, migration.sha256, migration.statements.length, plan.runId],
    });
  }

  return queries;
}

/** Reads the ledger. Returns empty on the very first run, before bootstrap. */
export async function readLedger(executor: PgExecutor): Promise<Map<string, string>> {
  const result = await executor.query({
    sql: `SELECT MIGRATION_ID, CONTENT_SHA256 FROM ${MIGRATION_TABLE}`,
    params: [],
  });
  const ledger = new Map<string, string>();
  for (const row of result.rows ?? []) {
    if (Array.isArray(row)) {
      ledger.set(String(row[0]), String(row[1]));
    } else {
      const record = row as Record<string, unknown>;
      ledger.set(
        String(record.migration_id ?? record.MIGRATION_ID),
        String(record.content_sha256 ?? record.CONTENT_SHA256),
      );
    }
  }
  return ledger;
}

export interface MigrateOptions {
  executor: PgExecutor;
  files: readonly MigrationFile[];
  runId: string;
  /** Progress reporting. Defaults to silence, so tests stay quiet. */
  log?: (message: string) => void;
}

/**
 * Applies every pending migration, or nothing.
 *
 * Throws on failure — see the report for the reasoning, but briefly: a green
 * deploy serving an app with no schema is worse than a red one that says why.
 * Every function in this app treats the schema as a hard precondition, and a
 * field crew's outbox will retry against a 500 for a week without a human ever
 * being told.
 */
export async function migratePostgres(options: MigrateOptions): Promise<MigrationOutcome> {
  const log = options.log ?? (() => {});

  for (const statement of BOOTSTRAP_STATEMENTS) {
    await options.executor.query({ sql: statement, params: [] });
  }

  const ledger = await readLedger(options.executor);
  const plan = buildPlan(options.files, ledger, options.runId);

  if (plan.pending.length === 0) {
    log(`schema up to date — ${plan.alreadyApplied.length} migration(s) already applied`);
    return { ...plan, applied: [], statementsExecuted: 0 };
  }

  for (const migration of plan.pending) {
    log(
      `pending: ${migration.id} (${migration.reason}, ${migration.statements.length} statements)`,
    );
  }

  const queries = buildMigrationQueries(plan);
  try {
    await options.executor.transaction(queries);
  } catch (err) {
    const wrapped = toPostgresError(err);
    // Postgres reports the failing statement in its own message; the file list
    // is what it cannot know, so add it rather than swallowing the original.
    throw new Error(
      `postgres migration failed and was rolled back (pending: ` +
        `${plan.pending.map((p) => p.id).join(', ')}): ${wrapped.message}`,
      { cause: wrapped },
    );
  }

  const claimed = await options.executor.query({
    sql: `SELECT MIGRATION_ID FROM ${MIGRATION_TABLE} WHERE APPLIED_RUN_ID = $1`,
    params: [options.runId],
  });
  const applied = (claimed.rows ?? []).map((row) =>
    Array.isArray(row)
      ? String(row[0])
      : String((row as Record<string, unknown>).migration_id ?? ''),
  );

  if (applied.length === 0) {
    log('another runner held the lock and applied these migrations first; nothing to record');
  } else {
    log(`applied: ${applied.join(', ')}`);
  }

  return {
    ...plan,
    applied,
    // The lock is a statement; it is not a migration statement.
    statementsExecuted: queries.length - 1,
  };
}
