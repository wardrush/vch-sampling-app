/**
 * The SQL port — one interface, two real backends and a fake.
 *
 * **Why this file exists.** MVP/UAT storage moves to a Netlify database (Neon
 * Postgres) because the Snowflake service user, key pair and network policy are
 * three days of approvals away and testers reacting to a running system is
 * worth more than a perfect warehouse. Snowflake stays a first-class backend,
 * selected by flag, because that is where this goes in production.
 *
 * The shape is generalised *from* `SnowflakeClient` rather than invented, and
 * deliberately so:
 *
 *  - `execute()` returns a `StatementResult` — `ColumnMeta[]` plus **row-major
 *    string cells**. That is the Snowflake SQL API v2's own representation, and
 *    keeping it means `asObjects`/`scalar` are unchanged and every existing call
 *    site keeps working. The Postgres adapter normalises *into* this shape; it
 *    does not get its own.
 *  - `asObjects` lowercases column names. Snowflake uppercases unquoted
 *    identifiers, Postgres lowercases them, and lowercasing both gives one
 *    answer on both backends for free.
 *  - Placeholders stay `?`, positional, on both backends. The Postgres adapter
 *    rewrites them to `$1…$n`. Wave B writes one placeholder style.
 *
 * **Where the two backends genuinely do not agree** is timestamps, and this
 * file does not pretend otherwise — see `asIsoTimestamp`.
 */

/** Which backend is behind the port. Branch on this, not on env vars. */
export type SqlDialect = 'snowflake' | 'postgres';

/**
 * What the backend can actually do. Every flag here corresponds to a measured
 * gap between the two dialects, so a caller that consults these covers the
 * whole gap rather than the part it happened to hit.
 */
export interface SqlCapabilities {
  /**
   * `ST_*` / `GEOGRAPHY` / `TO_GEOGRAPHY` are available.
   *
   * **`false` on Postgres — there is no PostGIS and geospatial is deferred.**
   * A caller that reads this flag and skips a derivation MUST record that it
   * skipped: see `GEO_DERIVATION_STATE` in `./geo-assurance.js`. "Not checked"
   * has to be distinguishable from "checked and passed" in the data, not only
   * in a log line.
   */
  readonly geospatial: boolean;
  /** `MERGE INTO … USING`. `false` on Postgres — use `INSERT … ON CONFLICT`. */
  readonly mergeInto: boolean;
  /** Snowflake's `QUALIFY`. `false` on Postgres — wrap the window fn in a subquery. */
  readonly qualify: boolean;
  /** `VARIANT` + `PARSE_JSON` + `FLATTEN`. `false` on Postgres — `::jsonb`, `jsonb_array_elements`. */
  readonly variantJson: boolean;
  /** `executeMulti` runs its statements inside one transaction. True on both. */
  readonly multiStatementTransaction: boolean;
  /**
   * A bare `?` in SQL is consumed as a bind placeholder.
   *
   * True on both, which is the point — but on Postgres it means the jsonb
   * existence operators `?`, `?|`, `?&` are unreachable. Write
   * `jsonb_exists(col, 'key')` instead.
   */
  readonly positionalPlaceholders: boolean;
}

export interface ColumnMeta {
  name: string;
  type: string;
  nullable?: boolean;
}

export interface StatementResult {
  /**
   * Snowflake: the server-side statement handle. Postgres: a client-generated
   * id, for log correlation only — the HTTP driver has no server handle.
   */
  statementHandle: string;
  columns: ColumnMeta[];
  /** Row-major, values as strings — the SQL API's own representation. */
  rows: (string | null)[][];
  numRowsInserted?: number;
  numRowsUpdated?: number;
}

export type BindValue = string | number | boolean | null | undefined | Date;

export interface ExecuteOptions {
  binds?: readonly BindValue[];
  /** Statement-level timeout in seconds. Snowflake only; ignored on Postgres. */
  timeoutSeconds?: number;
  /** Snowflake multi-statement count. Set by `executeMulti`; ignored on Postgres. */
  multiStatementCount?: number;
  /**
   * Reuse across a caller-level retry to keep server-side deduplication.
   *
   * Snowflake deduplicates on it, which is what makes blind retry safe there.
   * **Postgres has no equivalent** — the Neon HTTP driver gives no
   * request-level idempotency, so a retried write on that backend is only safe
   * because the writes themselves are keyed upserts. That is why the unique
   * constraints in `postgres_sampling_v01.sql` are load-bearing.
   */
  requestId?: string;
  deadlineMs?: number;
}

/**
 * The port. `SnowflakeClient` and `PostgresClient` both satisfy it structurally.
 *
 * Consumers should type their dependency as `SqlClient`, not as either concrete
 * class. Nothing in it is Snowflake-specific.
 */
export interface SqlClient {
  readonly dialect: SqlDialect;
  readonly capabilities: SqlCapabilities;
  execute(sql: string, options?: ExecuteOptions): Promise<StatementResult>;
  /**
   * Several statements as one unit of work, in one transaction.
   *
   * Binds are **one flat positional array across all the statements**, which is
   * Snowflake's multi-statement convention. The Postgres adapter splits that
   * array across statements by counting placeholders, so callers do not change.
   *
   * Only the **last** statement's result is returned, on both backends. Every
   * current caller ignores it.
   */
  executeMulti(statements: readonly string[], options?: ExecuteOptions): Promise<StatementResult>;
}

export const SNOWFLAKE_CAPABILITIES: SqlCapabilities = {
  geospatial: true,
  mergeInto: true,
  qualify: true,
  variantJson: true,
  multiStatementTransaction: true,
  positionalPlaceholders: true,
};

/** No PostGIS, no MERGE, no QUALIFY, no VARIANT. Deliberate, not an oversight. */
export const POSTGRES_CAPABILITIES: SqlCapabilities = {
  geospatial: false,
  mergeInto: false,
  qualify: false,
  variantJson: false,
  multiStatementTransaction: true,
  positionalPlaceholders: true,
};

/**
 * Maps a `StatementResult` to objects keyed by column name, lowercased.
 *
 * Snowflake returns unquoted identifiers uppercased; Postgres returns them
 * lowercased. Lowercasing here means server code reads `row.sample_uid` on
 * either backend and matches the shape of everything else in the codebase
 * rather than shouting.
 */
export function asObjects<T = Record<string, string | null>>(result: StatementResult): T[] {
  return result.rows.map((row) => {
    const obj: Record<string, string | null> = {};
    result.columns.forEach((col, i) => {
      obj[col.name.toLowerCase()] = row[i] ?? null;
    });
    return obj as T;
  });
}

/** The one-row, one-column case, which is most of the pipeline's reads. */
export function scalar(result: StatementResult): string | null {
  return result.rows[0]?.[0] ?? null;
}

/**
 * The one place the two backends genuinely disagree, made explicit.
 *
 * Snowflake's SQL API v2 renders `TIMESTAMP_NTZ` as **seconds since epoch**
 * (`"1755302400.000000000"`). The Postgres adapter renders `timestamptz` as
 * **ISO-8601 UTC** (`"2026-08-16T00:00:00.000Z"`), because that is what the
 * wire contract uses everywhere and what the fixtures already contain.
 *
 * There is no normalisation that is faithful to both, so instead of picking one
 * and hoping, any consumer that *parses* a timestamp read back out of the
 * database goes through here. It accepts either form. A value that is neither
 * comes back `null` rather than `Invalid Date`, because a silently invalid date
 * in an audit trail is worse than a missing one.
 */
export function asIsoTimestamp(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  // Snowflake epoch-seconds form: digits, optional sign, optional fraction.
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    const ms = Number(value) * 1000;
    if (!Number.isFinite(ms)) return null;
    const date = new Date(Math.round(ms));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
