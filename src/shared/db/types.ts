/**
 * The database surface the app codes against.
 *
 * Deliberately smaller than any driver's API. `wa-sqlite` over OPFS is the v1
 * implementation and Lane B wires it, but nothing above this interface knows
 * that — which is what lets tests run against an in-memory fake and what keeps
 * an OP-SQLite native build a swap rather than a rewrite.
 */

export type SqlValue = string | number | null | Uint8Array;

export interface SqlDatabase {
  /** Multi-statement DDL. No parameters, no results. */
  exec(sql: string): Promise<void>;
  /** One statement, parameterised, no results. */
  run(sql: string, params?: SqlValue[]): Promise<void>;
  /** One statement, parameterised, all rows. */
  all<T = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): Promise<T[]>;
}

export async function one<T>(
  db: SqlDatabase,
  sql: string,
  params?: SqlValue[],
): Promise<T | undefined> {
  const rows = await db.all<T>(sql, params);
  return rows[0];
}

/**
 * Runs `fn` inside a transaction, rolling back on throw.
 *
 * SQLite has no nested transactions; callers must not nest this. The outbox
 * worker is the only writer that needs it, and it takes one per drain step.
 */
export async function transaction<T>(db: SqlDatabase, fn: () => Promise<T>): Promise<T> {
  await db.exec('BEGIN IMMEDIATE');
  try {
    const result = await fn();
    await db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      await db.exec('ROLLBACK');
    } catch {
      // A failed rollback means the connection is already unusable; the
      // original error is the one worth surfacing.
    }
    throw err;
  }
}
