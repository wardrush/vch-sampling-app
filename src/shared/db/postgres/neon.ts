/**
 * The real driver behind `PgExecutor` — Neon's HTTP client.
 *
 * **HTTP, not WebSocket, deliberately.** One HTTPS round trip per query, no
 * session and no pool to keep warm across cold starts — the same reasoning that
 * put Snowflake behind the stateless SQL API v2 rather than a driver. The
 * WebSocket `Pool` export would give interactive transactions and session-scoped
 * advisory locks, and it needs a live socket per invocation, which is the one
 * thing a Netlify Function should not be holding. `migrate-postgres.ts` works
 * within that constraint rather than around it.
 *
 * `arrayMode: true, fullResults: true` is what `toStatementResult` expects: rows
 * as arrays plus `fields`, `command` and `rowCount`.
 */

import { neon } from '@neondatabase/serverless';
import type { PgExecutor, PgQuery } from './client.js';
import type { PgResultLike } from './normalise.js';

/**
 * The connection string is `NETLIFY_DATABASE_URL`, injected by Netlify into both
 * builds and functions. Nothing here reads the environment — `src/server/env.ts`
 * owns that, and owns failing loudly when it is missing.
 */
export function neonHttpExecutor(connectionString: string): PgExecutor {
  const sql = neon(connectionString, { arrayMode: true, fullResults: true });

  return {
    async query(query: PgQuery): Promise<PgResultLike> {
      return (await sql.query(query.sql, query.params)) as unknown as PgResultLike;
    },

    async transaction(queries: readonly PgQuery[]): Promise<PgResultLike[]> {
      if (queries.length === 0) return [];
      const results = await sql.transaction(
        queries.map((q) => sql.query(q.sql, q.params)),
      );
      return results as unknown as PgResultLike[];
    },
  };
}
