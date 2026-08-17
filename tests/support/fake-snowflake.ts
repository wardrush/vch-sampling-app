/**
 * A recording stand-in for `SnowflakeClient`.
 *
 * Tests assert on the SQL that was issued and the binds that went with it,
 * which is the only thing that can be checked without a warehouse — and, for
 * the properties that matter here (idempotent MERGE keys, one parse, ordered
 * writes), it is the thing worth checking.
 */

import type { SnowflakeClient, ExecuteOptions, StatementResult } from '../../src/shared/snowflake/client.js';

export interface RecordedStatement {
  sql: string;
  binds: readonly unknown[];
}

export class FakeSnowflake {
  readonly statements: RecordedStatement[] = [];
  /** Queued results, consumed in order by `execute`. */
  private readonly results: StatementResult[] = [];
  private failNext: Error | null = null;
  private failMatcher: { needle: string; error: Error } | null = null;

  queueRows(columns: string[], rows: (string | null)[][]): void {
    this.results.push({
      statementHandle: `handle-${this.results.length}`,
      columns: columns.map((name) => ({ name, type: 'TEXT' })),
      rows,
    });
  }

  failOnce(error: Error): void {
    this.failNext = error;
  }

  /** Fails the next statement whose text contains `needle`, once. */
  failWhen(needle: string, error: Error): void {
    this.failMatcher = { needle, error };
  }

  async execute(sql: string, options: ExecuteOptions = {}): Promise<StatementResult> {
    this.statements.push({ sql, binds: options.binds ?? [] });
    if (this.failMatcher && sql.includes(this.failMatcher.needle)) {
      const err = this.failMatcher.error;
      this.failMatcher = null;
      throw err;
    }
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    return (
      this.results.shift() ?? {
        statementHandle: 'empty',
        columns: [],
        rows: [],
      }
    );
  }

  async executeMulti(statements: readonly string[], options: ExecuteOptions = {}): Promise<StatementResult> {
    return this.execute(statements.join(';\n'), options);
  }

  /** Statements whose text contains `needle`. */
  matching(needle: string): RecordedStatement[] {
    return this.statements.filter((s) => s.sql.includes(needle));
  }

  asClient(): SnowflakeClient {
    return this as unknown as SnowflakeClient;
  }
}
