/**
 * A12 — the DDL deploy runner.
 *
 * **Blocked on the Snowflake service user, key pair and network policy**
 * (pre-work item 5; three days to approve, five minutes to do). The deploy
 * itself is five minutes, and this is those five minutes, written down so they
 * happen the hour the credentials land rather than a day later.
 *
 *   npx tsx tools/deploy-ddl.ts --dry-run
 *   npx tsx tools/deploy-ddl.ts
 *
 * Statements run one at a time in file order, and the runner stops at the first
 * failure with the statement printed. Every file is `CREATE … IF NOT EXISTS`,
 * `ALTER … ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE VIEW` or a guarded
 * seed, so re-running a partially applied deploy is safe — which is the
 * property you want at the point where a deploy has just failed halfway.
 */

import { readFile } from 'node:fs/promises';
import { SnowflakeClient } from '../src/shared/snowflake/client.js';
import { snowflakeConfig } from '../src/server/env.js';

/** Deploy order is load-bearing: the addendum ALTERs tables v01 creates. */
const FILES = [
  'snowflake_sampling_v01.sql',
  'snowflake_v02_addendum.sql',
  'snowflake_v03_entity_compat.sql',
];

/**
 * Splits on semicolons outside of string literals, line comments and
 * `$$ … $$` procedure bodies.
 *
 * The procedure bodies are why this is not `sql.split(';')`:
 * `SP_RESOLVE_SAMPLE_BOUNDARY` contains three semicolons of its own.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inSingle = false;
  let inLineComment = false;
  let inBlockComment = false;
  let inDollar = false;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    if (inLineComment) {
      current += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      current += ch;
      if (ch === '*' && next === '/') {
        current += next;
        i += 1;
        inBlockComment = false;
      }
      continue;
    }
    if (inDollar) {
      current += ch;
      if (ch === '$' && next === '$') {
        current += next;
        i += 1;
        inDollar = false;
      }
      continue;
    }
    if (inSingle) {
      current += ch;
      // '' is an escaped quote inside a literal, not the end of one.
      if (ch === "'" && next === "'") {
        current += next;
        i += 1;
      } else if (ch === "'") {
        inSingle = false;
      }
      continue;
    }

    if (ch === '-' && next === '-') {
      inLineComment = true;
      current += ch;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      current += ch;
      continue;
    }
    if (ch === '$' && next === '$') {
      inDollar = true;
      current += ch + next;
      i += 1;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      current += ch;
      continue;
    }
    if (ch === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) statements.push(current.trim());

  return statements.filter((s) => !isOnlyComments(s));
}

function isOnlyComments(statement: string): boolean {
  return statement
    .split('\n')
    .every((line) => line.trim() === '' || line.trim().startsWith('--'));
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const client = dryRun ? null : new SnowflakeClient(snowflakeConfig());

  for (const file of FILES) {
    const sql = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
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
  console.log('\nDDL deploy complete.');
}

function firstLine(statement: string): string {
  const line = statement.split('\n').find((l) => l.trim() && !l.trim().startsWith('--')) ?? '';
  return line.trim().slice(0, 80);
}

// Run only when invoked directly, so the splitter can be unit-tested.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[/\\]/, ''))) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
