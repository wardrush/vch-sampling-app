/**
 * `SqlDatabase` over Node's built-in SQLite.
 *
 * Real SQLite, not a fake: the outbox's `ON CONFLICT` clause, its unique
 * constraint and `PRAGMA user_version` all behave here exactly as they will on
 * a phone under `wa-sqlite`. A hand-rolled fake would have agreed with whatever
 * the tests assumed.
 */

import { createRequire } from 'node:module';
import type { SqlDatabase, SqlValue } from '../../src/shared/db/types.js';

// `node:sqlite` is newer than Vite's builtin list, so a static import gets
// rewritten to a bare `sqlite` specifier and fails to resolve. Going through
// `createRequire` keeps it a genuine Node builtin lookup.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
    close(): void;
  };
};

type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

export class NodeSqliteDb implements SqlDatabase {
  readonly db: DatabaseSyncInstance;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async run(sql: string, params: SqlValue[] = []): Promise<void> {
    this.db.prepare(sql).run(...(params as never[]));
  }

  async all<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }

  close(): void {
    this.db.close();
  }
}
