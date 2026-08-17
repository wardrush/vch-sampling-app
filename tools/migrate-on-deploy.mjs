/**
 * Deploy-time migration gate. Build plumbing, so orchestrator-owned rather
 * than any one agent's (`tools/deploy-ddl.ts` itself is schema-steward's).
 *
 * Why this exists rather than chaining `npm run db:migrate` directly in
 * netlify.toml: `deploy-ddl.ts` **fails loudly** when `NETLIFY_DATABASE_URL`
 * is missing, which is correct for a run somebody asked for -- a migration
 * that silently no-ops is how a deploy goes green with an empty schema behind
 * it. But it is wrong for an unconditional build step, because the Snowflake
 * and mock backends legitimately have no Postgres URL and their deploys must
 * not fail on its absence. Snowflake stays a first-class backend behind the
 * flag; that is the whole point of the flag.
 *
 * So: absent URL is a *skip* (exit 0, and say so). Present URL means somebody
 * provisioned a database and expects it used, so any failure from there on is
 * a real failure and fails the deploy.
 */

import { spawnSync } from 'node:child_process';

const url = process.env.NETLIFY_DATABASE_URL;

if (!url) {
  console.log(
    '[migrate-on-deploy] NETLIFY_DATABASE_URL is not set — skipping the Postgres\n' +
      '                    migration. This is expected on the Snowflake and mock\n' +
      '                    backends. Provision a Netlify database to enable it.'
  );
  process.exit(0);
}

console.log('[migrate-on-deploy] NETLIFY_DATABASE_URL present — applying Postgres schema.');

// Idempotent and lock-guarded, so running this on every deploy converges the
// schema instead of duplicating it. Inherits stdio so the statement-by-statement
// output lands in the Netlify build log, which is the only place anyone will
// look when a deploy goes red.
const result = spawnSync('npm', ['run', 'db:migrate'], { stdio: 'inherit' });

if (result.error) {
  console.error('[migrate-on-deploy] could not start the migration:', result.error.message);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(
    `[migrate-on-deploy] migration failed (exit ${result.status}). Failing the deploy on\n` +
      '                    purpose: the client is an offline outbox with automatic retry, so\n' +
      '                    shipping a green deploy behind a broken schema would have it retry\n' +
      '                    against 500s for days while telling nobody.'
  );
  process.exit(result.status ?? 1);
}

console.log('[migrate-on-deploy] schema is up to date.');
