/**
 * The dialect seam for the sync and derivation SQL.
 *
 * MVP/UAT storage is a Netlify database (Neon Postgres); Snowflake stays the
 * production backend. `SqlClient` (`src/shared/db/port.ts`) hides *how* a
 * statement is sent, but it deliberately does not hide **what the statement may
 * say** — the two dialects genuinely differ, and the port publishes a
 * `capabilities` record rather than pretending otherwise.
 *
 * This module is the one place that knows the differences that matter to
 * `src/server/{sync,derive}/**`:
 *
 * | Snowflake | Postgres | Why it cannot be papered over |
 * |---|---|---|
 * | `CURRENT_TIMESTAMP()` | `CURRENT_TIMESTAMP` | Postgres rejects the parentheses outright |
 * | `CURRENT_USER()` | `CURRENT_USER::text` | same, plus `name` → `varchar` needs an explicit cast to be safe |
 * | `PARSE_JSON(?)` | `(?)::jsonb` | |
 * | `v.value:key::VARCHAR` | `(v.value ->> 'key')::text` | |
 * | `TABLE(FLATTEN(input => x)) v` | `jsonb_array_elements(x) WITH ORDINALITY AS v(value, ord)` | the alias is chosen so **`v.value` is spelled the same on both**, which is what keeps one projection for both dialects |
 * | `ARRAY_AGG(e)` | `COALESCE(jsonb_agg(e), '[]'::jsonb)` | `jsonb_agg` of no rows is `NULL`, and `jsonb_array_elements(NULL)` yields nothing rather than an empty array — the `COALESCE` keeps "no records of this type" a no-op instead of a silence that looks like one |
 * | `MERGE INTO … USING` | `INSERT … ON CONFLICT (pk) DO UPDATE … WHERE guard` | see `./merge.ts` |
 *
 * **`ordinal()` exists for one reason.** `ON CONFLICT DO UPDATE` refuses to
 * affect the same row twice *in one statement*, so a source array carrying the
 * same client key twice is a hard error on Postgres where Snowflake's
 * `WHEN NOT MATCHED` would quietly insert two rows (Snowflake enforces no
 * primary key). Neither is acceptable, so `./merge.ts` de-duplicates on the key
 * and keeps the **last** occurrence — and "last" needs an ordering, which is
 * what the ordinality column provides.
 *
 * Nothing here interpolates a caller value into SQL. Every argument is either a
 * fixed identifier from a mapping table in this repository or an already-built
 * SQL fragment; values travel as `?` binds, on both backends.
 */

import type { SqlClient, SqlDialect } from '../../shared/db/port.js';

/** The JSON-payload casts the curated projections need. */
export type JsonScalarType = 'text' | 'number' | 'float' | 'boolean' | 'timestamp' | 'date';

const SNOWFLAKE_TYPES: Record<JsonScalarType, string> = {
  text: 'VARCHAR',
  number: 'NUMBER',
  float: 'FLOAT',
  boolean: 'BOOLEAN',
  timestamp: 'TIMESTAMP_NTZ',
  date: 'DATE',
};

/**
 * `TIMESTAMP_NTZ → timestamptz` is the steward's deliberate divergence
 * (`postgres_sampling_v01.sql`): every timestamp this app writes is an ISO-8601
 * string with a `Z`, and a zone-less column would silently discard the offset.
 */
const POSTGRES_TYPES: Record<JsonScalarType, string> = {
  text: 'text',
  number: 'numeric',
  float: 'double precision',
  boolean: 'boolean',
  timestamp: 'timestamptz',
  date: 'date',
};

export interface SqlSyntax {
  readonly dialect: SqlDialect;
  /** Statement-time clock. */
  readonly now: string;
  /** The writing role, cast so it is assignable to a `varchar` column. */
  readonly currentUser: string;
  /** A bind carrying a JSON document, as a JSON value. */
  parseJson(bind?: string): string;
  /** Scalar extraction from a JSON value, cast to a column type. */
  jsonScalar(expr: string, key: string, type: JsonScalarType): string;
  /** Sub-document extraction, left as a JSON value (`VARIANT` / `jsonb`). */
  jsonSubtree(expr: string, key: string): string;
  /** FROM-clause fragment iterating a JSON array; exposes `<alias>.value`. */
  jsonArrayRows(sourceExpr: string, alias: string): string;
  /** Position of a row within the iterated array, 1-based. */
  ordinal(alias: string): string;
  /** Aggregate of a JSON expression into a JSON array. */
  jsonArrayAgg(expr: string): string;
}

const SNOWFLAKE_SYNTAX: SqlSyntax = {
  dialect: 'snowflake',
  now: 'CURRENT_TIMESTAMP()',
  currentUser: 'CURRENT_USER()',
  parseJson: (bind = '?') => `PARSE_JSON(${bind})`,
  jsonScalar: (expr, key, type) => `${expr}:${key}::${SNOWFLAKE_TYPES[type]}`,
  jsonSubtree: (expr, key) => `${expr}:${key}`,
  jsonArrayRows: (sourceExpr, alias) => `TABLE(FLATTEN(input => ${sourceExpr})) ${alias}`,
  ordinal: (alias) => `${alias}.index`,
  jsonArrayAgg: (expr) => `ARRAY_AGG(${expr})`,
};

const POSTGRES_SYNTAX: SqlSyntax = {
  dialect: 'postgres',
  now: 'CURRENT_TIMESTAMP',
  currentUser: 'CURRENT_USER::text',
  parseJson: (bind = '?') => `(${bind})::jsonb`,
  jsonScalar: (expr, key, type) => `(${expr} ->> '${key}')::${POSTGRES_TYPES[type]}`,
  jsonSubtree: (expr, key) => `(${expr} -> '${key}')`,
  jsonArrayRows: (sourceExpr, alias) =>
    `jsonb_array_elements(${sourceExpr}) WITH ORDINALITY AS ${alias}(value, ord)`,
  ordinal: (alias) => `${alias}.ord`,
  jsonArrayAgg: (expr) => `COALESCE(jsonb_agg(${expr}), '[]'::jsonb)`,
};

/** The syntax for a client, or for a dialect named directly (tests, builders). */
export function syntaxFor(source: SqlDialect | Pick<SqlClient, 'dialect'>): SqlSyntax {
  const dialect = typeof source === 'string' ? source : source.dialect;
  return dialect === 'postgres' ? POSTGRES_SYNTAX : SNOWFLAKE_SYNTAX;
}

/**
 * The two backends' `capabilities.mergeInto` decides the write form, but a
 * caller reads better asking this.
 */
export function usesUpsert(client: Pick<SqlClient, 'capabilities'>): boolean {
  return !client.capabilities.mergeInto;
}
