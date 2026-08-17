/**
 * Postgres result → `StatementResult`, with the string-row convention intact.
 *
 * `asObjects()` is the consumer-facing helper on both backends, so whatever this
 * function produces has to make `asObjects` behave identically to Snowflake's.
 * That means every cell is a **string or null**, and the string has to be the
 * one the existing consumers already parse.
 *
 * The mapping, and why each row of it is what it is:
 *
 * | Postgres / driver value | Rendered as | Because |
 * |---|---|---|
 * | `null`, `undefined` | `null` | |
 * | `boolean` | `'true'` / `'false'` | `src/server/defects/harness.ts`'s `bool()` tests `'true' \| '1' \| 'TRUE'`. Postgres' own *text* output is `t`/`f`, which that helper reads as **false** — so letting raw text through would silently invert every boolean. This is the single subtlest thing in the adapter. |
 * | `number`, `bigint` | `String(v)` | matches the SQL API, which stringifies numerics |
 * | `Date` | ISO-8601 UTC | see `asIsoTimestamp` in `../port.js` — the one genuine divergence, handled explicitly rather than papered over |
 * | `Uint8Array` / `Buffer` | base64 | no in-scope column is `bytea`; bytes live in Netlify Blobs. Defined so it cannot surprise anyone |
 * | array / object (jsonb, `text[]`) | `JSON.stringify(v)` | Snowflake returns `VARIANT`/`ARRAY` as JSON text and consumers `JSON.parse` it (`toSpec`, `findExistingImport`). `JSON.stringify` reproduces that exactly |
 * | `string` | itself | including `numeric`/`int8`, which the driver already returns as strings |
 *
 * Numeric note: `pg` returns `numeric` and `int8` as strings to avoid float
 * precision loss, which is the same thing Snowflake does and the same thing the
 * consumers expect. Nothing here needs to intervene.
 */

import { randomUUID } from 'node:crypto';
import type { ColumnMeta, StatementResult } from '../port.js';

/** The subset of the driver's `FullQueryResults` this adapter depends on. */
export interface PgFieldLike {
  name: string;
  dataTypeID?: number;
}

export interface PgResultLike {
  fields?: PgFieldLike[];
  rows?: unknown[];
  rowCount?: number | null;
  command?: string;
}

/**
 * One Postgres value → one result cell.
 *
 * Exported because it is the part worth testing directly; every subtle bug in
 * this adapter lives in this function.
 */
export function normaliseValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  // Explicit, ahead of `typeof object`: `'true'`/`'false'`, never `t`/`f`.
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('base64');
  }
  // jsonb, json, and Postgres array types all arrive as JS arrays/objects.
  return JSON.stringify(value);
}

/** Postgres type OIDs worth naming, so `ColumnMeta.type` is not just a number. */
const TYPE_NAMES: Record<number, string> = {
  16: 'BOOLEAN',
  17: 'BINARY',
  20: 'FIXED',
  21: 'FIXED',
  23: 'FIXED',
  25: 'TEXT',
  114: 'JSON',
  700: 'REAL',
  701: 'REAL',
  1007: 'ARRAY',
  1009: 'ARRAY',
  1042: 'TEXT',
  1043: 'TEXT',
  1082: 'DATE',
  1114: 'TIMESTAMP_NTZ',
  1184: 'TIMESTAMP_TZ',
  1700: 'FIXED',
  2950: 'TEXT',
  3802: 'VARIANT',
};

function typeNameFor(oid: number | undefined): string {
  if (oid === undefined) return 'TEXT';
  return TYPE_NAMES[oid] ?? `OID_${oid}`;
}

/**
 * Normalises one Postgres result into a `StatementResult`.
 *
 * Requires the driver in `arrayMode: true, fullResults: true` — rows as arrays,
 * plus `fields`. Object-mode rows are also accepted and projected through
 * `fields`, so a caller that forgets `arrayMode` degrades to correct-but-slower
 * rather than to garbage.
 */
export function toStatementResult(
  result: PgResultLike,
  handle: string = randomUUID(),
): StatementResult {
  const fields = result.fields ?? [];
  const columns: ColumnMeta[] = fields.map((f) => ({
    name: f.name,
    type: typeNameFor(f.dataTypeID),
  }));

  const rows: (string | null)[][] = (result.rows ?? []).map((row) => {
    if (Array.isArray(row)) return row.map(normaliseValue);
    const record = row as Record<string, unknown>;
    return fields.map((f) => normaliseValue(record[f.name]));
  });

  const command = (result.command ?? '').toUpperCase();
  const affected = result.rowCount ?? undefined;

  return {
    statementHandle: handle,
    columns,
    rows,
    // Snowflake reports these separately. Postgres reports one `rowCount` and a
    // command tag, so it is attributed to whichever field the command implies —
    // and MERGE, which Postgres 15+ accepts but this backend does not use,
    // cannot be split at all. Named here so nobody reads more into these two
    // numbers on Postgres than is actually there.
    numRowsInserted: command === 'INSERT' ? affected : undefined,
    numRowsUpdated:
      command === 'UPDATE' || command === 'DELETE' || command === 'MERGE' ? affected : undefined,
  };
}
