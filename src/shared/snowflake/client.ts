/**
 * A1 — Snowflake SQL API v2 client, key-pair JWT, stateless.
 *
 * **One of two backends behind `SqlClient`** (`src/shared/db/port.ts`), and the
 * one this goes to in production. Selected by `SQL_BACKEND=snowflake`; still
 * fails loudly without its own credentials, exactly as before.
 *
 * `StatementResult`, `ColumnMeta`, `ExecuteOptions`, `BindValue`, `asObjects` and
 * `scalar` now live in the port and are re-exported here, so every existing
 * `import … from '.../snowflake/client.js'` keeps working unchanged. The
 * Postgres adapter normalises *into* this file's representation rather than
 * getting one of its own.
 *
 * Shape decisions worth defending:
 *
 *  - **`requestId` is generated once per logical statement and reused across
 *    retries** (`retry=true` on resubmission). Snowflake deduplicates on it, so
 *    a timeout that actually committed does not run the statement twice. Blind
 *    retry is only safe because of this, and blind retry is what a function on
 *    a flaky network needs.
 *  - **202 is normal, not an error.** A statement over Snowflake's synchronous
 *    threshold returns a handle; the client polls it inside the caller's
 *    deadline. Netlify's 60 s synchronous ceiling is the real budget, so the
 *    deadline is a parameter and not a constant.
 *  - **`fetch` is injected.** Every test in this repo runs offline.
 */

import { randomUUID } from 'node:crypto';
import { createJwtProvider, type KeyPairJwtConfig } from './jwt.js';
import {
  SNOWFLAKE_CAPABILITIES,
  type BindValue,
  type ColumnMeta,
  type ExecuteOptions,
  type SqlCapabilities,
  type SqlClient,
  type SqlDialect,
  type StatementResult,
} from '../db/port.js';

// Re-exported so existing importers of this module do not change. The canonical
// definitions are in the port; `Binding` / `toBinding` stay here because the
// `{type, value}` envelope is the SQL API's wire form and nothing else uses it.
export type {
  BindValue,
  ColumnMeta,
  ExecuteOptions,
  SqlCapabilities,
  SqlClient,
  SqlDialect,
  StatementResult,
} from '../db/port.js';
export { asObjects, scalar, asIsoTimestamp } from '../db/port.js';

export interface SnowflakeConfig extends KeyPairJwtConfig {
  /** Hostname, e.g. `xy12345.us-east-1.snowflakecomputing.com`. */
  host?: string;
  warehouse?: string;
  database?: string;
  schema?: string;
  role?: string;
  /** Wall-clock budget for one `execute` including polls. Default 45 s. */
  deadlineMs?: number;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** A bound value, in the SQL API's `{type, value}` form. */
export interface Binding {
  type: 'TEXT' | 'FIXED' | 'REAL' | 'BOOLEAN' | 'TIMESTAMP_NTZ' | 'DATE';
  value: string | null;
}

/**
 * JS value → SQL API binding.
 *
 * `undefined` and `null` both become a TEXT null. Snowflake infers the column
 * type from the target on insert, and a typed null buys nothing while an
 * untyped `undefined` reaching the wire buys a 400 nobody enjoys reading.
 */
export function toBinding(value: BindValue): Binding {
  if (value === null || value === undefined) return { type: 'TEXT', value: null };
  if (typeof value === 'boolean') return { type: 'BOOLEAN', value: String(value) };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`cannot bind non-finite number: ${value}`);
    return Number.isInteger(value)
      ? { type: 'FIXED', value: String(value) }
      : { type: 'REAL', value: String(value) };
  }
  if (value instanceof Date) {
    return { type: 'TIMESTAMP_NTZ', value: value.toISOString().replace('Z', '') };
  }
  return { type: 'TEXT', value };
}

export function toBindings(values: readonly BindValue[]): Record<string, Binding> {
  const out: Record<string, Binding> = {};
  values.forEach((v, i) => {
    out[String(i + 1)] = toBinding(v);
  });
  return out;
}

export class SnowflakeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
    readonly retryable: boolean,
    readonly statementHandle?: string,
  ) {
    super(message);
    this.name = 'SnowflakeError';
  }
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const POLL_INTERVAL_MS = 500;
const MAX_POLL_INTERVAL_MS = 4_000;
const MAX_ATTEMPTS = 4;

export class SnowflakeClient implements SqlClient {
  readonly dialect: SqlDialect = 'snowflake';
  readonly capabilities: SqlCapabilities = SNOWFLAKE_CAPABILITIES;

  private readonly jwt: () => string;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly baseUrl: string;

  constructor(private readonly config: SnowflakeConfig) {
    this.jwt = createJwtProvider(config, config.now);
    this.doFetch = config.fetch ?? globalThis.fetch;
    this.now = config.now ?? Date.now;
    this.sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const host =
      config.host ?? `${config.account.toLowerCase()}.snowflakecomputing.com`;
    this.baseUrl = `https://${host}/api/v2/statements`;
  }

  /** Executes one statement and returns every row. */
  async execute(sql: string, options: ExecuteOptions = {}): Promise<StatementResult> {
    const requestId = options.requestId ?? randomUUID();
    const deadline = this.now() + (options.deadlineMs ?? this.config.deadlineMs ?? 45_000);

    const body: Record<string, unknown> = {
      statement: sql,
      timeout: options.timeoutSeconds ?? 60,
    };
    if (this.config.warehouse) body.warehouse = this.config.warehouse;
    if (this.config.database) body.database = this.config.database;
    if (this.config.schema) body.schema = this.config.schema;
    if (this.config.role) body.role = this.config.role;
    if (options.binds?.length) body.bindings = toBindings(options.binds);
    if (options.multiStatementCount !== undefined) {
      body.parameters = { MULTI_STATEMENT_COUNT: String(options.multiStatementCount) };
    }

    let attempt = 0;
    for (;;) {
      attempt += 1;
      const url = `${this.baseUrl}?requestId=${requestId}${attempt > 1 ? '&retry=true' : ''}`;
      let response: Response;
      try {
        response = await this.doFetch(url, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body),
        });
      } catch (err) {
        // Network-level failure. The statement may or may not have run; the
        // stable requestId is what makes retrying it safe.
        if (attempt >= MAX_ATTEMPTS || this.now() >= deadline) {
          throw new SnowflakeError(`snowflake request failed: ${String(err)}`, 0, undefined, true);
        }
        await this.backoff(attempt);
        continue;
      }

      if (response.status === 200) return this.collect(await response.json(), deadline);
      if (response.status === 202) {
        const payload = (await response.json()) as { statementHandle: string };
        return this.poll(payload.statementHandle, deadline);
      }

      const err = await this.toError(response);
      if (!err.retryable || attempt >= MAX_ATTEMPTS || this.now() >= deadline) throw err;
      await this.backoff(attempt);
    }
  }

  /**
   * Runs several statements as one Snowflake request.
   *
   * Snowflake wraps a multi-statement request in a single transaction when
   * `MULTI_STATEMENT_COUNT` is set, which is exactly what an ordered
   * multi-table write like `/ingest/commit` needs — and the reason that
   * endpoint does not need to invent its own compensation logic.
   */
  async executeMulti(statements: readonly string[], options: ExecuteOptions = {}): Promise<StatementResult> {
    return this.execute(statements.join(';\n'), {
      ...options,
      multiStatementCount: statements.length,
    });
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.jwt()}`,
      'X-Snowflake-Authorization-Token-Type': 'KEYPAIR_JWT',
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'vch-sampling-app/1.0',
    };
  }

  private async backoff(attempt: number): Promise<void> {
    const base = Math.min(250 * 2 ** (attempt - 1), 4_000);
    await this.sleep(base + Math.random() * base * 0.5);
  }

  private async poll(handle: string, deadline: number): Promise<StatementResult> {
    let interval = POLL_INTERVAL_MS;
    for (;;) {
      if (this.now() >= deadline) {
        throw new SnowflakeError(
          `statement ${handle} still running at deadline`,
          408,
          'DEADLINE_EXCEEDED',
          true,
          handle,
        );
      }
      await this.sleep(interval);
      interval = Math.min(interval * 2, MAX_POLL_INTERVAL_MS);

      const response = await this.doFetch(`${this.baseUrl}/${handle}`, {
        method: 'GET',
        headers: this.headers(),
      });
      if (response.status === 200) return this.collect(await response.json(), deadline);
      if (response.status === 202) continue;
      throw await this.toError(response, handle);
    }
  }

  /**
   * Follows `partitionInfo` to the end.
   *
   * A result over ~100 MB arrives in partitions and partition 0 is already in
   * hand. Silently returning only partition 0 is the kind of bug that shows up
   * as "the analyst queue is missing yesterday's afternoon".
   */
  private async collect(first: unknown, deadline: number): Promise<StatementResult> {
    const payload = first as SqlApiResultSet;
    const meta = payload.resultSetMetaData;
    const columns: ColumnMeta[] = (meta?.rowType ?? []).map((c) => ({
      name: c.name,
      type: c.type,
      nullable: c.nullable,
    }));
    const rows: (string | null)[][] = [...(payload.data ?? [])];
    const handle = payload.statementHandle ?? '';

    const partitions = meta?.partitionInfo ?? [];
    for (let i = 1; i < partitions.length; i += 1) {
      if (this.now() >= deadline) {
        throw new SnowflakeError(
          `deadline reached after ${i} of ${partitions.length} partitions`,
          408,
          'DEADLINE_EXCEEDED',
          true,
          handle,
        );
      }
      const response = await this.doFetch(`${this.baseUrl}/${handle}?partition=${i}`, {
        method: 'GET',
        headers: this.headers(),
      });
      if (response.status !== 200) throw await this.toError(response, handle);
      const part = (await response.json()) as SqlApiResultSet;
      rows.push(...(part.data ?? []));
    }

    const stats = payload.stats;
    return {
      statementHandle: handle,
      columns,
      rows,
      numRowsInserted: stats?.numRowsInserted,
      numRowsUpdated: stats?.numRowsUpdated,
    };
  }

  private async toError(response: Response, handle?: string): Promise<SnowflakeError> {
    let code: string | undefined;
    let message = `snowflake http ${response.status}`;
    try {
      const body = (await response.json()) as { code?: string; message?: string };
      code = body.code;
      if (body.message) message = body.message;
    } catch {
      /* non-JSON error body; the status is the whole story */
    }
    return new SnowflakeError(message, response.status, code, RETRYABLE_STATUS.has(response.status), handle);
  }
}

interface SqlApiResultSet {
  statementHandle?: string;
  data?: (string | null)[][];
  resultSetMetaData?: {
    numRows?: number;
    rowType?: Array<{ name: string; type: string; nullable?: boolean }>;
    partitionInfo?: Array<{ rowCount: number; uncompressedSize: number }>;
  };
  stats?: { numRowsInserted?: number; numRowsUpdated?: number };
}

