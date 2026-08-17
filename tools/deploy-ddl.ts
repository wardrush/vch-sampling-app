/**
 * The DDL deploy runner — two targets.
 *
 *   npx tsx tools/deploy-ddl.ts --target=postgres --dry-run
 *   npx tsx tools/deploy-ddl.ts --target=postgres
 *   npx tsx tools/deploy-ddl.ts --dry-run                    # snowflake, default
 *   npx tsx tools/deploy-ddl.ts
 *
 * ## `--target=snowflake` (the default, unchanged)
 *
 * **A12 is still blocked on the Snowflake service user, key pair and network
 * policy** — pre-work item 5; three days to approve, five minutes to do. The
 * deploy itself is those five minutes, written down so they happen the hour the
 * credentials land rather than a day later. `--dry-run` is the honest ceiling
 * until then and nothing here simulates a deploy to look finished.
 *
 * Statements run one at a time in file order and the runner stops at the first
 * failure with the statement printed. Every file is `CREATE … IF NOT EXISTS`,
 * `ALTER … ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE VIEW` or a guarded
 * seed, so re-running a partially applied deploy is safe — which is the property
 * you want at the point where a deploy has just failed halfway.
 *
 * ## `--target=postgres`
 *
 * **This is meant to run on every deploy.** The Netlify database is empty until
 * something applies DDL to it, and nothing else does. Wire it as a build step
 * and a fresh database self-provisions on first deploy with no manual steps:
 *
 *     npx tsx tools/deploy-ddl.ts --target=postgres
 *
 * (`netlify.toml` and `package.json` are orchestrator-owned, so this file does
 * not wire itself. The command above is the whole request.)
 *
 * It delegates to `migratePostgres()`, which takes `pg_advisory_xact_lock`,
 * applies only what the `META.SCHEMA_MIGRATION` ledger says is pending, and does
 * the whole thing in one transaction so a failure rolls back rather than leaving
 * half a schema. It **exits non-zero on failure**, deliberately: a green deploy
 * serving an app with no schema is worse than a red one that says why.
 *
 * `NETLIFY_DATABASE_URL` is injected by Netlify into builds and functions. Its
 * absence is a hard failure, not a silent no-op — see `src/server/env.ts`.
 */

import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { SnowflakeClient } from '../src/shared/snowflake/client.js';
import { migrationDatabaseUrl, snowflakeConfig } from '../src/server/env.js';
import { neonHttpExecutor } from '../src/shared/db/postgres/neon.js';
import {
  buildMigrationQueries,
  buildPlan,
  migratePostgres,
  MIGRATION_LOCK_KEYS,
  type MigrationFile,
} from '../src/shared/db/migrate-postgres.js';
import { firstLine, splitStatements } from '../src/shared/db/sql-statements.js';

/**
 * Re-exported for `tests/unit/schema-and-ingest.test.ts`, which imports it from
 * here. The implementation moved to `src/shared/db/sql-statements.ts` because the
 * Postgres migration runner needs it too and `src → tools` is the wrong
 * direction for an import.
 */
export { splitStatements } from '../src/shared/db/sql-statements.js';

/** Deploy order is load-bearing: the addendum ALTERs tables v01 creates. */
const SNOWFLAKE_FILES = [
  'snowflake_sampling_v01.sql',
  'snowflake_v02_addendum.sql',
  'snowflake_v03_entity_compat.sql',
];

/**
 * Append-only, never renamed, never renumbered — the id in
 * `META.SCHEMA_MIGRATION` is the filename. A file whose content hash changes is
 * re-applied, which is correct for additive idempotent DDL and is why adding a
 * column is a deploy rather than a ceremony.
 */
const POSTGRES_FILES = ['postgres_sampling_v01.sql'];

type Target = 'snowflake' | 'postgres';

async function readSqlFile(file: string): Promise<string> {
  return readFile(new URL(`../${file}`, import.meta.url), 'utf8');
}

// ---------------------------------------------------------------------------
// Snowflake
// ---------------------------------------------------------------------------

async function deploySnowflake(dryRun: boolean): Promise<void> {
  const client = dryRun ? null : new SnowflakeClient(snowflakeConfig());

  for (const file of SNOWFLAKE_FILES) {
    const sql = await readSqlFile(file);
    const statements = splitStatements(sql);
    console.log(`\n=== ${file} — ${statements.length} statements ===`);

    for (const [index, statement] of statements.entries()) {
      const label = `${file}[${index + 1}/${statements.length}] ${firstLine(statement)}`;
      if (dryRun) {
        console.log(`  would run: ${label}`);
        continue;
      }
      try {
        await client!.execute(statement, { timeoutSeconds: 300, deadlineMs: 300_000 });
        console.log(`  ok: ${label}`);
      } catch (err) {
        console.error(`\nFAILED: ${label}\n`);
        console.error(statement);
        throw err;
      }
    }
  }
  // Say which of the two happened. A12 is blocked on pre-work item 5 and a dry
  // run that prints "deploy complete" is exactly how a blocked task gets
  // reported as done.
  console.log(
    dryRun
      ? '\nSnowflake DRY RUN complete. Nothing was applied and no warehouse was contacted.'
      : '\nSnowflake DDL deploy complete.',
  );
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

async function loadPostgresFiles(): Promise<MigrationFile[]> {
  return Promise.all(
    POSTGRES_FILES.map(async (id) => ({ id, sql: await readSqlFile(id) })),
  );
}

/**
 * Prints the exact plan the live path would execute, including the advisory lock
 * and the ledger writes.
 *
 * The ledger is assumed empty, because there is no connection to read it from —
 * so a dry run always shows a first-deploy plan. Stated in the output rather
 * than implied, because "would run 0 statements" and "cannot see the ledger" are
 * very different things to be told.
 */
async function dryRunPostgres(): Promise<void> {
  const files = await loadPostgresFiles();
  const plan = buildPlan(files, new Map(), 'dry-run');
  const queries = buildMigrationQueries(plan);

  console.log('\n=== postgres — DRY RUN, no connection opened ===');
  console.log(
    `  ledger not read (no database connection); plan shown as for a FIRST deploy.\n` +
      `  against a database that already has these migrations, the runner would skip them.`,
  );
  console.log(
    `  advisory lock: pg_advisory_xact_lock(${MIGRATION_LOCK_KEYS[0]}, ${MIGRATION_LOCK_KEYS[1]})`,
  );
  for (const migration of plan.pending) {
    console.log(
      `\n  --- ${migration.id} (${migration.reason}, sha ${migration.sha256.slice(0, 12)}) ` +
        `— ${migration.statements.length} statements`,
    );
    migration.statements.forEach((statement, i) => {
      console.log(`    [${i + 1}/${migration.statements.length}] ${firstLine(statement)}`);
    });
  }
  console.log(
    `\n  ${queries.length} statement(s) in one transaction ` +
      `(1 lock + ${queries.length - 1 - plan.pending.length} DDL + ${plan.pending.length} ledger).`,
  );
  console.log('\nDry run only. Nothing was applied and no database was contacted.');
}

async function deployPostgres(): Promise<void> {
  const files = await loadPostgresFiles();
  // Throws with the variable named if it is missing. A migration that silently
  // no-ops against a missing database is how a deploy goes green with an empty
  // schema behind it.
  const executor = neonHttpExecutor(migrationDatabaseUrl());
  const runId = randomUUID();

  console.log(`\n=== postgres — applying, run ${runId} ===`);
  const outcome = await migratePostgres({
    executor,
    files,
    runId,
    log: (message) => console.log(`  ${message}`),
  });

  console.log(
    `\nPostgres migration complete: ${outcome.applied.length} applied, ` +
      `${outcome.alreadyApplied.length} already current, ` +
      `${outcome.statementsExecuted} statement(s) executed.`,
  );
}

// ---------------------------------------------------------------------------

function parseTarget(argv: readonly string[]): Target {
  const arg = argv.find((a) => a.startsWith('--target='));
  // Defaults to snowflake so the pre-existing invocations in this file's header
  // keep meaning what they meant.
  const value = arg ? arg.slice('--target='.length) : 'snowflake';
  if (value !== 'snowflake' && value !== 'postgres') {
    throw new Error(`--target must be snowflake or postgres, got "${value}"`);
  }
  return value;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const target = parseTarget(process.argv);

  if (target === 'snowflake') {
    await deploySnowflake(dryRun);
    return;
  }
  if (dryRun) {
    await dryRunPostgres();
    return;
  }
  await deployPostgres();
}

// Run only when invoked directly, so the splitter can be unit-tested.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[/\\]/, ''))) {
  main().catch((err) => {
    console.error(err);
    // Non-zero on purpose: the schema is a hard precondition for every function
    // in this app, so a failed migration must fail the deploy.
    process.exitCode = 1;
  });
}
