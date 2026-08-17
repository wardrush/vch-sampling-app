/**
 * The Neon/Postgres adapter for the SQL port.
 *
 * Satisfies `SqlClient` structurally, so a consumer typed against the port
 * takes this or `SnowflakeClient` without knowing which. `asObjects()` and
 * `scalar()` behave identically on both — that property is what keeps the query
 * port small, and `tests/unit/postgres-adapter.test.ts` is what checks it,
 * because there is no live database to catch a mistake here.
 *
 * Three shape decisions, each mirroring one from `SnowflakeClient`:
 *
 *  - **The driver is injected.** `SnowflakeClient` injects `fetch` so every test
 *    in this repo runs offline; this injects a `PgExecutor` for the same reason.
 *    `neonHttpExecutor()` in `./neon.js` is the real one.
 *  - **Retry is bounded and only on retryable classes.** Unlike Snowflake there
 *    is **no request-level deduplication** on this backend, so a retried write
 *    is safe only because the writes are keyed upserts — see the unique
 *    constraints in `postgres_sampling_v01.sql`. Retrying a non-idempotent
 *    statement here would double-apply it, so the retryable set is deliberately
 *    narrow: transient connection and concurrency errors, nothing else.
 *  - **`executeMulti` is one transaction.** Neon's HTTP driver sends a batch of
 *    queries as a single non-interactive transaction, which is what
 *    `/ingest/commit`'s ordered multi-table write needs and the reason it does
 *    not have to invent compensation logic on this backend either.
 */

import { randomUUID } from 'node:crypto';
import type {
  BindValue,
  ExecuteOptions,
  SqlCapabilities,
  SqlClient,
  SqlDialect,
  StatementResult,
} from '../port.js';
import { POSTGRES_CAPABILITIES } from '../port.js';
import { toStatementResult, type PgResultLike } from './normalise.js';
import { rewritePlaceholders, splitMultiStatementBinds } from './placeholders.js';

/** One query, placeholders already rewritten to `$n`. */
export interface PgQuery {
  sql: string;
  params: unknown[];
}

/**
 * What the adapter needs from a driver.
 *
 * Narrow on purpose: it is the whole surface a test double has to implement, and
 * it is satisfiable by the Neon HTTP driver, the Neon WebSocket `Pool`, or
 * `node-postgres`, without the adapter caring which.
 */
export interface PgExecutor {
  query(query: PgQuery): Promise<PgResultLike>;
  /** All statements in one transaction, results in order. */
  transaction(queries: readonly PgQuery[]): Promise<PgResultLike[]>;
}

export interface PostgresClientConfig {
  executor: PgExecutor;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Wall-clock budget for one `execute` including retries. Default 45 s. */
  deadlineMs?: number;
  maxAttempts?: number;
}

export class PostgresError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'PostgresError';
  }
}

/**
 * Transient classes only.
 *
 * `40001`/`40P01` are concurrency retries the transaction is expected to take;
 * `08*`/`57P01`/`53300` are the connection dying under a cold start. A
 * constraint violation or a syntax error is **not** here: retrying either just
 * burns the deadline and hides the fault.
 */
const RETRYABLE_CODES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '08000', // connection_exception
  '08003', // connection_does_not_exist
  '08006', // connection_failure
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
  '53300', // too_many_connections
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
]);

const MAX_ATTEMPTS = 4;

export class PostgresClient implements SqlClient {
  readonly dialect: SqlDialect = 'postgres';
  readonly capabilities: SqlCapabilities = POSTGRES_CAPABILITIES;

  private readonly executor: PgExecutor;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;

  constructor(private readonly config: PostgresClientConfig) {
    this.executor = config.executor;
    this.now = config.now ?? Date.now;
    this.sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxAttempts = config.maxAttempts ?? MAX_ATTEMPTS;
  }

  async execute(sql: string, options: ExecuteOptions = {}): Promise<StatementResult> {
    const { sql: text, count } = rewritePlaceholders(sql);
    const binds = options.binds ?? [];
    if (count !== binds.length) {
      throw new PostgresError(
        `statement has ${count} placeholder(s) but ${binds.length} bind(s) were supplied`,
        undefined,
        false,
      );
    }
    const params = binds.map(toPgParam);
    const handle = options.requestId ?? randomUUID();

    const result = await this.withRetry(
      () => this.executor.query({ sql: text, params }),
      options,
    );
    return toStatementResult(result, handle);
  }

  async executeMulti(
    statements: readonly string[],
    options: ExecuteOptions = {},
  ): Promise<StatementResult> {
    if (statements.length === 0) {
      throw new PostgresError('executeMulti called with no statements', undefined, false);
    }
    const split = splitMultiStatementBinds(statements, options.binds ?? []);
    const queries: PgQuery[] = split.map((s) => ({
      sql: s.sql,
      params: s.binds.map(toPgParam),
    }));
    const handle = options.requestId ?? randomUUID();

    const results = await this.withRetry(() => this.executor.transaction(queries), options);
    // Only the last statement's result, matching `SnowflakeClient.executeMulti`.
    const last = results[results.length - 1] ?? {};
    return toStatementResult(last, handle);
  }

  private async withRetry<T>(run: () => Promise<T>, options: ExecuteOptions): Promise<T> {
    const deadline = this.now() + (options.deadlineMs ?? this.config.deadlineMs ?? 45_000);
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        return await run();
      } catch (err) {
        const wrapped = toPostgresError(err);
        if (!wrapped.retryable || attempt >= this.maxAttempts || this.now() >= deadline) {
          throw wrapped;
        }
        await this.backoff(attempt);
      }
    }
  }

  private async backoff(attempt: number): Promise<void> {
    const base = Math.min(250 * 2 ** (attempt - 1), 4_000);
    await this.sleep(base + Math.random() * base * 0.5);
  }
}

/**
 * JS value → Postgres parameter.
 *
 * Deliberately thinner than Snowflake's `toBinding`: the wire protocol carries
 * types, so there is no `{type, value}` envelope to build. `undefined` becomes
 * `null` for the same reason it does there — an untyped `undefined` reaching the
 * driver buys an error nobody enjoys reading.
 */
export function toPgParam(value: BindValue): unknown {
  if (value === undefined) return null;
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new PostgresError(`cannot bind non-finite number: ${String(value)}`, undefined, false);
  }
  return value;
}

/** Driver / Postgres error → `PostgresError`, with the retryable decision made once. */
export function toPostgresError(err: unknown): PostgresError {
  if (err instanceof PostgresError) return err;

  const source = err as { code?: unknown; message?: unknown; name?: unknown } | null;
  const code = typeof source?.code === 'string' ? source.code : undefined;
  const message =
    typeof source?.message === 'string' ? source.message : `postgres request failed: ${String(err)}`;

  // A fetch/socket failure carries no SQLSTATE. It is a transport fault by
  // definition, so it is retryable — the same reasoning as SnowflakeClient's
  // network-level branch.
  const transport =
    code === undefined &&
    (source?.name === 'TypeError' ||
      source?.name === 'FetchError' ||
      /fetch failed|network|socket|ECONN|ETIMEDOUT|EAI_AGAIN/i.test(message));

  return new PostgresError(message, code, transport || (code !== undefined && RETRYABLE_CODES.has(code)));
}
