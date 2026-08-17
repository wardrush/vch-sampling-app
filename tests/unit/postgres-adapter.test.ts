/**
 * The Neon/Postgres adapter.
 *
 * **There is no live database.** Nothing here has been run against one, and the
 * whole point of this file is that result normalisation is the part most likely
 * to be subtly wrong and the part with no runtime feedback to catch it. So the
 * assertions are mostly *differential*: the same logical result, shaped the
 * Snowflake way and the Postgres way, must come out of `asObjects()` identical.
 * That property is what lets a call site keep its query and change one type.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  asIsoTimestamp,
  asObjects,
  scalar,
  POSTGRES_CAPABILITIES,
  type StatementResult,
} from '../../src/shared/db/port.js';
import {
  normaliseValue,
  toStatementResult,
  type PgResultLike,
} from '../../src/shared/db/postgres/normalise.js';
import {
  PlaceholderError,
  countPlaceholders,
  rewritePlaceholders,
  splitMultiStatementBinds,
} from '../../src/shared/db/postgres/placeholders.js';
import {
  PostgresClient,
  PostgresError,
  toPgParam,
  toPostgresError,
  type PgExecutor,
  type PgQuery,
} from '../../src/shared/db/postgres/client.js';
import {
  BOOTSTRAP_STATEMENTS,
  MIGRATION_LOCK_KEYS,
  buildMigrationQueries,
  buildPlan,
  migratePostgres,
  sha256Hex,
} from '../../src/shared/db/migrate-postgres.js';
import {
  GEO_DERIVATION_STATE,
  REVIEW_STATE,
  cleanReviewStateFor,
  geoStateForCapability,
  isGeoVerified,
} from '../../src/shared/db/geo-assurance.js';
import { SnowflakeClient } from '../../src/shared/snowflake/client.js';

// ---------------------------------------------------------------------------
// A recording executor. Mirrors tests/support/fake-snowflake.ts's approach: the
// driver is injected so every test in this repo runs offline.
// ---------------------------------------------------------------------------

class FakePg implements PgExecutor {
  readonly queries: PgQuery[] = [];
  readonly transactions: PgQuery[][] = [];
  private readonly results: PgResultLike[] = [];
  private failures: Error[] = [];

  queue(result: PgResultLike): void {
    this.results.push(result);
  }

  /** Fails the next `n` calls with `error`, then succeeds. */
  failTimes(n: number, error: Error): void {
    this.failures = Array.from({ length: n }, () => error);
  }

  async query(query: PgQuery): Promise<PgResultLike> {
    this.queries.push(query);
    const failure = this.failures.shift();
    if (failure) throw failure;
    return this.results.shift() ?? { fields: [], rows: [], command: 'SELECT', rowCount: 0 };
  }

  async transaction(queries: readonly PgQuery[]): Promise<PgResultLike[]> {
    this.transactions.push([...queries]);
    const failure = this.failures.shift();
    if (failure) throw failure;
    return queries.map(
      () => this.results.shift() ?? { fields: [], rows: [], command: 'SELECT', rowCount: 0 },
    );
  }
}

const client = (executor: PgExecutor) =>
  new PostgresClient({ executor, sleep: async () => {}, now: () => 0 });

/**
 * Removes `--` comments, respecting single-quoted literals and `$$` bodies, so a
 * test can assert on what actually executes. A naive line filter is not enough:
 * this file uses trailing comments heavily, and `-- see note` also appears
 * *inside* a seeded string literal that must survive.
 */
function stripComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'") {
      const start = i;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          i += 1;
          break;
        } else i += 1;
      }
      out += sql.slice(start, i);
      continue;
    }
    if (ch === '$' && sql[i + 1] === '$') {
      const close = sql.indexOf('$$', i + 2);
      const stop = close === -1 ? sql.length : close + 2;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------

describe('normaliseValue', () => {
  it('renders booleans as true/false, never Postgres t/f', () => {
    // THE subtlest thing in the adapter. `bool()` in
    // src/server/defects/harness.ts tests 'true' | '1' | 'TRUE'. Postgres' own
    // text output for a boolean is 't'/'f', which that helper reads as FALSE --
    // so passing raw text through would silently invert every boolean in the
    // defect rules.
    expect(normaliseValue(true)).toBe('true');
    expect(normaliseValue(false)).toBe('false');
    expect(normaliseValue(true)).not.toBe('t');
  });

  it('renders nulls and undefined as null', () => {
    expect(normaliseValue(null)).toBeNull();
    expect(normaliseValue(undefined)).toBeNull();
  });

  it('stringifies numbers and bigints without losing the value', () => {
    expect(normaliseValue(42)).toBe('42');
    expect(normaliseValue(-3.5)).toBe('-3.5');
    expect(normaliseValue(0)).toBe('0');
    expect(normaliseValue(9007199254740993n)).toBe('9007199254740993');
  });

  it('passes numeric strings straight through', () => {
    // pg returns numeric and int8 as strings to avoid float precision loss,
    // which is what Snowflake does and what consumers parse. Nothing intervenes.
    expect(normaliseValue('30.0')).toBe('30.0');
    expect(normaliseValue('-93.12345678')).toBe('-93.12345678');
  });

  it('renders timestamps as ISO-8601 UTC', () => {
    expect(normaliseValue(new Date('2026-08-16T12:34:56.000Z'))).toBe(
      '2026-08-16T12:34:56.000Z',
    );
  });

  it('renders an invalid Date as null rather than "Invalid Date"', () => {
    expect(normaliseValue(new Date('nonsense'))).toBeNull();
  });

  it('renders jsonb and array columns as JSON text, which is what consumers parse', () => {
    // `toSpec` does JSON.parse(row.required_media_roles) and
    // `findExistingImport` does JSON.parse(row.plan_ids). Snowflake returns
    // ARRAY/VARIANT as JSON text; this has to reproduce that.
    const roles = normaliseValue(['label_photo', 'core_photo', 'site_photo']);
    expect(JSON.parse(roles!)).toEqual(['label_photo', 'core_photo', 'site_photo']);

    const nested = normaliseValue({ records: [{ entity_type: 'sample_point' }] });
    expect(JSON.parse(nested!)).toEqual({ records: [{ entity_type: 'sample_point' }] });
  });

  it('base64s bytea rather than emitting an object', () => {
    expect(normaliseValue(new Uint8Array([1, 2, 3]))).toBe('AQID');
  });
});

describe('toStatementResult', () => {
  it('produces the same asObjects output as the Snowflake shape', () => {
    // The whole promise of the port, as one assertion.
    const snowflake: StatementResult = {
      statementHandle: 'sf',
      columns: [
        { name: 'SAMPLE_UID', type: 'TEXT' },
        { name: 'GEOG_VALID', type: 'BOOLEAN' },
        { name: 'OFFSET_FROM_PLAN_M', type: 'FIXED' },
        { name: 'BOUNDARY_ID', type: 'TEXT' },
      ],
      rows: [['uid-1', 'true', '12.50', null]],
    };

    const postgres = toStatementResult(
      {
        // Postgres lowercases unquoted identifiers; asObjects lowercases both.
        fields: [
          { name: 'sample_uid', dataTypeID: 1043 },
          { name: 'geog_valid', dataTypeID: 16 },
          { name: 'offset_from_plan_m', dataTypeID: 1700 },
          { name: 'boundary_id', dataTypeID: 1043 },
        ],
        rows: [['uid-1', true, '12.50', null]],
        command: 'SELECT',
        rowCount: 1,
      },
      'pg',
    );

    expect(asObjects(postgres)).toEqual(asObjects(snowflake));
    expect(asObjects(postgres)).toEqual([
      {
        sample_uid: 'uid-1',
        geog_valid: 'true',
        offset_from_plan_m: '12.50',
        boundary_id: null,
      },
    ]);
  });

  it('supports scalar() the same way', () => {
    const result = toStatementResult({
      fields: [{ name: 'count', dataTypeID: 20 }],
      rows: [['7']],
      command: 'SELECT',
      rowCount: 1,
    });
    expect(scalar(result)).toBe('7');
    expect(Number(scalar(result) ?? 0)).toBe(7);
  });

  it('returns null from scalar() on an empty result, not undefined', () => {
    expect(scalar(toStatementResult({ fields: [], rows: [] }))).toBeNull();
  });

  it('projects object-mode rows through fields when arrayMode was not set', () => {
    const result = toStatementResult({
      fields: [{ name: 'a', dataTypeID: 1043 }, { name: 'b', dataTypeID: 16 }],
      rows: [{ a: 'x', b: false }],
      command: 'SELECT',
      rowCount: 1,
    });
    expect(asObjects(result)).toEqual([{ a: 'x', b: 'false' }]);
  });

  it('attributes rowCount by command tag', () => {
    const inserted = toStatementResult({ fields: [], rows: [], command: 'INSERT', rowCount: 3 });
    expect(inserted.numRowsInserted).toBe(3);
    expect(inserted.numRowsUpdated).toBeUndefined();

    const updated = toStatementResult({ fields: [], rows: [], command: 'UPDATE', rowCount: 5 });
    expect(updated.numRowsUpdated).toBe(5);
    expect(updated.numRowsInserted).toBeUndefined();
  });
});

describe('asIsoTimestamp', () => {
  it('accepts the Snowflake epoch-seconds form', () => {
    // Snowflake's SQL API renders TIMESTAMP_NTZ as seconds since epoch.
    expect(asIsoTimestamp('1786838400.000000000')).toBe('2026-08-16T00:00:00.000Z');
    expect(asIsoTimestamp('1786838400')).toBe('2026-08-16T00:00:00.000Z');
  });

  it('accepts the Postgres ISO form and is a no-op on it', () => {
    expect(asIsoTimestamp('2026-08-16T00:00:00.000Z')).toBe('2026-08-16T00:00:00.000Z');
  });

  it('returns null for absent or unparseable values rather than an invalid date', () => {
    expect(asIsoTimestamp(null)).toBeNull();
    expect(asIsoTimestamp('')).toBeNull();
    expect(asIsoTimestamp(undefined)).toBeNull();
    expect(asIsoTimestamp('not a date')).toBeNull();
  });
});

describe('placeholder rewriting', () => {
  it('numbers ? as $1..$n in order', () => {
    const { sql, count } = rewritePlaceholders(
      'SELECT * FROM CURATED.SAMPLE_POINT WHERE SYNC_BATCH_ID = ? AND LAT > ?',
    );
    expect(sql).toBe(
      'SELECT * FROM CURATED.SAMPLE_POINT WHERE SYNC_BATCH_ID = $1 AND LAT > $2',
    );
    expect(count).toBe(2);
  });

  it('leaves a ? inside a string literal alone', () => {
    const { sql, count } = rewritePlaceholders(`SELECT 'why? because' AS X WHERE A = ?`);
    expect(sql).toBe(`SELECT 'why? because' AS X WHERE A = $1`);
    expect(count).toBe(1);
  });

  it("handles the '' escape inside a literal", () => {
    const { sql, count } = rewritePlaceholders(
      `SELECT 'this bag''s barcode? no' WHERE A = ?`,
    );
    expect(sql).toBe(`SELECT 'this bag''s barcode? no' WHERE A = $1`);
    expect(count).toBe(1);
  });

  it('leaves a ? inside a line comment or a block comment alone', () => {
    expect(rewritePlaceholders('-- is this ok?\nSELECT ?').sql).toBe('-- is this ok?\nSELECT $1');
    expect(rewritePlaceholders('/* really? */ SELECT ?').sql).toBe('/* really? */ SELECT $1');
  });

  it('leaves a ? inside a quoted identifier alone', () => {
    const { sql, count } = rewritePlaceholders('SELECT "odd?name" FROM T WHERE A = ?');
    expect(sql).toBe('SELECT "odd?name" FROM T WHERE A = $1');
    expect(count).toBe(1);
  });

  it('leaves a ? and a semicolon inside a $$ body alone', () => {
    const sql = `DO $$ BEGIN RAISE EXCEPTION 'what?'; END $$`;
    expect(rewritePlaceholders(sql).sql).toBe(sql);
    expect(countPlaceholders(sql)).toBe(0);
  });

  it('does not treat $1 as the start of a dollar-quoted body', () => {
    expect(rewritePlaceholders('SELECT $1, ?').sql).toBe('SELECT $1, $1');
  });

  it('refuses jsonb existence operators rather than mangling them', () => {
    // `?`, `?|` and `?&` cannot be told apart from a placeholder by any lexer,
    // which is why node-postgres has the same limitation. Failing loudly beats
    // producing a query that is quietly wrong.
    expect(() => rewritePlaceholders(`SELECT * FROM T WHERE J ?| ARRAY['a']`)).toThrow(
      PlaceholderError,
    );
    expect(() => rewritePlaceholders(`SELECT * FROM T WHERE J ?& ARRAY['a']`)).toThrow(
      /jsonb_exists/,
    );
  });

  it('throws on an unterminated literal instead of silently rewriting the tail', () => {
    expect(() => rewritePlaceholders(`SELECT 'oops`)).toThrow(PlaceholderError);
  });
});

describe('splitMultiStatementBinds', () => {
  it("splits Snowflake's one flat bind array across statements", () => {
    // executeMulti's contract: one positional array across every statement.
    // Postgres needs each query to carry its own $1..$k.
    const split = splitMultiStatementBinds(
      [
        'MERGE_LIKE_UPSERT INTO A VALUES (?, ?)',
        'UPDATE CURATED.DEVICE SET LAST_SEEN_TS = ? WHERE DEVICE_ID = ?',
      ],
      ['a1', 'a2', 'ts', 'dev'],
    );
    expect(split).toHaveLength(2);
    expect(split[0]!.sql).toBe('MERGE_LIKE_UPSERT INTO A VALUES ($1, $2)');
    expect(split[0]!.binds).toEqual(['a1', 'a2']);
    expect(split[1]!.sql).toBe(
      'UPDATE CURATED.DEVICE SET LAST_SEEN_TS = $1 WHERE DEVICE_ID = $2',
    );
    expect(split[1]!.binds).toEqual(['ts', 'dev']);
  });

  it('throws when the counts disagree rather than borrowing the wrong bind', () => {
    // A mismatch is always a caller bug. The alternative -- Postgres taking a
    // bind that belonged to the next statement -- writes the wrong row and
    // returns success.
    expect(() => splitMultiStatementBinds(['INSERT INTO A VALUES (?, ?)'], ['only'])).toThrow(
      /needs 2 bind/,
    );
    expect(() => splitMultiStatementBinds(['INSERT INTO A VALUES (?)'], ['a', 'b'])).toThrow(
      /2 bind\(s\) supplied/,
    );
  });
});

describe('PostgresClient', () => {
  it('satisfies the port and declares no geospatial', () => {
    const c = client(new FakePg());
    expect(c.dialect).toBe('postgres');
    expect(c.capabilities).toEqual(POSTGRES_CAPABILITIES);
    expect(c.capabilities.geospatial).toBe(false);
    expect(c.capabilities.mergeInto).toBe(false);
    expect(c.capabilities.qualify).toBe(false);
    expect(c.capabilities.variantJson).toBe(false);
  });

  it('is assignable to the same SqlClient slot as SnowflakeClient', () => {
    // A structural check, but the one that matters: this is what lets a consumer
    // type its dependency as SqlClient and take either backend.
    const both = [
      client(new FakePg()),
      new SnowflakeClient({ account: 'a', user: 'u', privateKeyPem: 'pem' }),
    ];
    expect(both.map((c) => c.dialect)).toEqual(['postgres', 'snowflake']);
    expect(both.map((c) => c.capabilities.geospatial)).toEqual([false, true]);
  });

  it('rewrites placeholders and passes binds through as native values', async () => {
    const pg = new FakePg();
    await client(pg).execute('SELECT * FROM T WHERE A = ? AND B = ? AND C = ?', {
      binds: ['x', 42, true],
    });
    expect(pg.queries[0]!.sql).toBe('SELECT * FROM T WHERE A = $1 AND B = $2 AND C = $3');
    expect(pg.queries[0]!.params).toEqual(['x', 42, true]);
  });

  it('rejects a bind-count mismatch before it reaches the driver', async () => {
    await expect(
      client(new FakePg()).execute('SELECT ? , ?', { binds: ['one'] }),
    ).rejects.toThrow(/2 placeholder\(s\) but 1 bind/);
  });

  it('sends executeMulti as one transaction with the binds split', async () => {
    const pg = new FakePg();
    await client(pg).executeMulti(['INSERT INTO A VALUES (?)', 'UPDATE B SET X = ? WHERE Y = ?'], {
      binds: ['a', 'x', 'y'],
    });
    expect(pg.transactions).toHaveLength(1);
    expect(pg.queries).toHaveLength(0);
    expect(pg.transactions[0]).toEqual([
      { sql: 'INSERT INTO A VALUES ($1)', params: ['a'] },
      { sql: 'UPDATE B SET X = $1 WHERE Y = $2', params: ['x', 'y'] },
    ]);
  });

  it('retries a transient failure and not a constraint violation', async () => {
    const transient = Object.assign(new Error('connection_failure'), { code: '08006' });
    const pg = new FakePg();
    pg.failTimes(1, transient);
    await expect(client(pg).execute('SELECT 1')).resolves.toBeDefined();
    expect(pg.queries).toHaveLength(2);

    const violation = Object.assign(new Error('duplicate key'), { code: '23505' });
    const pg2 = new FakePg();
    pg2.failTimes(1, violation);
    await expect(client(pg2).execute('SELECT 1')).rejects.toThrow(PostgresError);
    expect(pg2.queries).toHaveLength(1);
  });

  it('classifies a transport failure with no SQLSTATE as retryable', () => {
    expect(toPostgresError(new TypeError('fetch failed')).retryable).toBe(true);
    expect(toPostgresError(Object.assign(new Error('x'), { code: '42601' })).retryable).toBe(
      false,
    );
  });

  it('binds undefined as null and refuses a non-finite number', () => {
    expect(toPgParam(undefined)).toBeNull();
    expect(toPgParam(null)).toBeNull();
    expect(() => toPgParam(Number.NaN)).toThrow(/non-finite/);
    expect(() => toPgParam(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
  });
});

describe('geospatial assurance', () => {
  it('treats only the derived states as checked', () => {
    expect(isGeoVerified(GEO_DERIVATION_STATE.DERIVED_GEODESIC)).toBe(true);
    expect(isGeoVerified(GEO_DERIVATION_STATE.DERIVED_PLANAR)).toBe(true);
    expect(isGeoVerified(GEO_DERIVATION_STATE.DEFERRED_NO_GEOSPATIAL)).toBe(false);
    expect(isGeoVerified(GEO_DERIVATION_STATE.PENDING)).toBe(false);
    // Deliberate: a bad coordinate means containment and offset were never
    // evaluated either, so it is not "checked".
    expect(isGeoVerified(GEO_DERIVATION_STATE.INVALID_GEOMETRY)).toBe(false);
    expect(isGeoVerified(null)).toBe(false);
  });

  it('never reports a full pass when the geographic checks did not run', () => {
    // This is the property the CHECK constraint in postgres_sampling_v01.sql
    // enforces at the database. Asserted here too so the two cannot drift.
    expect(cleanReviewStateFor(GEO_DERIVATION_STATE.DERIVED_GEODESIC)).toBe(
      REVIEW_STATE.SCREENED,
    );
    expect(cleanReviewStateFor(GEO_DERIVATION_STATE.DEFERRED_NO_GEOSPATIAL)).toBe(
      REVIEW_STATE.SCREENED_PARTIAL,
    );
    expect(cleanReviewStateFor(null)).toBe(REVIEW_STATE.SCREENED_PARTIAL);
  });

  it('maps a backend capability to the state its rows must carry', () => {
    expect(geoStateForCapability(true)).toBe(GEO_DERIVATION_STATE.DERIVED_GEODESIC);
    expect(geoStateForCapability(false)).toBe(GEO_DERIVATION_STATE.DEFERRED_NO_GEOSPATIAL);
  });

  it('agrees with the CHECK constraint domains in the DDL', async () => {
    const sql = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../../postgres_sampling_v01.sql', import.meta.url), 'utf8'),
    );
    for (const state of Object.values(GEO_DERIVATION_STATE)) {
      expect(sql).toContain(`'${state}'`);
    }
    for (const state of Object.values(REVIEW_STATE)) {
      expect(sql).toContain(`'${state}'`);
    }
    // The constraint itself, verbatim -- if someone loosens it, this fails.
    expect(sql).toContain('CONSTRAINT SAMPLE_POINT_SCREENED_REQUIRES_GEO');
    expect(sql).toContain(
      "OR GEO_DERIVATION_STATE IN ('derived_geodesic', 'derived_planar')",
    );
  });

  it('keeps the DEFECT_FIELD_VISIBILITY seed, for every code the app can raise', async () => {
    // REF.DEFECT_FIELD_VISIBILITY shipped EMPTY in v02, which hid every defect
    // from the field. This is a fresh table on this backend, so the seed has to
    // be here -- and it has to cover the codes the running code actually emits.
    const [sql, codes] = await Promise.all([
      import('node:fs/promises').then((fs) =>
        fs.readFile(new URL('../../postgres_sampling_v01.sql', import.meta.url), 'utf8'),
      ),
      import('../../src/shared/codes/index.js'),
    ]);
    const visibilitySeed = sql.slice(sql.indexOf('INSERT INTO REF.DEFECT_FIELD_VISIBILITY'));
    for (const code of Object.values(codes.DEFECT_CODE)) {
      expect(sql, `REF.DEFECT_CODE missing ${code}`).toContain(`'${code}'`);
      expect(visibilitySeed, `REF.DEFECT_FIELD_VISIBILITY missing ${code}`).toContain(
        `'${code}'`,
      );
    }
  });
});

describe('migratePostgres', () => {
  const files = [{ id: 'a.sql', sql: 'CREATE TABLE IF NOT EXISTS A (X int);' }];

  it('takes the advisory lock as the first statement of the transaction', async () => {
    const pg = new FakePg();
    await migratePostgres({ executor: pg, files, runId: 'run-1' });

    const tx = pg.transactions[0]!;
    expect(tx[0]!.sql).toContain('pg_advisory_xact_lock');
    expect(tx[0]!.params).toEqual([MIGRATION_LOCK_KEYS[0], MIGRATION_LOCK_KEYS[1]]);
  });

  it('bootstraps META.SCHEMA_MIGRATION before reading the ledger', async () => {
    const pg = new FakePg();
    await migratePostgres({ executor: pg, files, runId: 'run-1' });
    expect(pg.queries[0]!.sql).toBe(BOOTSTRAP_STATEMENTS[0]);
    expect(pg.queries[1]!.sql).toContain('META.SCHEMA_MIGRATION');
    expect(pg.queries[2]!.sql).toContain('SELECT MIGRATION_ID, CONTENT_SHA256');
  });

  it('records the file with its content hash, stamped with this run', async () => {
    const pg = new FakePg();
    await migratePostgres({ executor: pg, files, runId: 'run-1' });
    const ledgerWrite = pg.transactions[0]!.at(-1)!;
    expect(ledgerWrite.sql).toContain('ON CONFLICT (MIGRATION_ID) DO UPDATE');
    expect(ledgerWrite.params).toEqual(['a.sql', sha256Hex(files[0]!.sql), 1, 'run-1']);
  });

  it('is a no-op when the ledger hash matches — this is the every-deploy path', async () => {
    const pg = new FakePg();
    pg.queue({ fields: [], rows: [], command: 'CREATE', rowCount: 0 });
    pg.queue({ fields: [], rows: [], command: 'CREATE', rowCount: 0 });
    pg.queue({
      fields: [{ name: 'migration_id' }, { name: 'content_sha256' }],
      rows: [['a.sql', sha256Hex(files[0]!.sql)]],
      command: 'SELECT',
      rowCount: 1,
    });

    const outcome = await migratePostgres({ executor: pg, files, runId: 'run-2' });
    expect(outcome.pending).toEqual([]);
    expect(outcome.alreadyApplied).toEqual(['a.sql']);
    expect(outcome.applied).toEqual([]);
    expect(outcome.statementsExecuted).toBe(0);
    expect(pg.transactions).toHaveLength(0);
  });

  it('re-applies a file whose content changed, and says why', async () => {
    const ledger = new Map([['a.sql', 'a-different-hash']]);
    const plan = buildPlan(files, ledger, 'run-3');
    expect(plan.pending).toHaveLength(1);
    expect(plan.pending[0]!.reason).toBe('content_changed');
    expect(plan.pending[0]!.previousSha256).toBe('a-different-hash');
  });

  it('reports applying nothing when a racing runner won the lock', async () => {
    const pg = new FakePg();
    // bootstrap x2, empty ledger read, transaction, then the run-id read comes
    // back empty because the other runner wrote the rows under its own run id.
    const outcome = await migratePostgres({ executor: pg, files, runId: 'run-4' });
    expect(outcome.pending).toHaveLength(1);
    expect(outcome.applied).toEqual([]);
  });

  it('wraps a failure with the pending file list and does not swallow the cause', async () => {
    const pg = new FakePg();
    pg.failTimes(3, new Error('syntax error at or near "CRATE"'));
    // The first two failures land on the bootstrap statements, so make those
    // succeed and only fail the transaction.
    const failing: PgExecutor = {
      query: (q) => pg.query(q),
      transaction: async () => {
        throw Object.assign(new Error('syntax error at or near "CRATE"'), { code: '42601' });
      },
    };
    const clean = new FakePg();
    await expect(
      migratePostgres({
        executor: { query: (q) => clean.query(q), transaction: failing.transaction },
        files,
        runId: 'run-5',
      }),
    ).rejects.toThrow(/rolled back \(pending: a.sql\).*syntax error/s);
  });

  it('plans the real DDL file into statements including the DO assertions', async () => {
    const sql = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../../postgres_sampling_v01.sql', import.meta.url), 'utf8'),
    );
    const plan = buildPlan([{ id: 'postgres_sampling_v01.sql', sql }], new Map(), 'plan');
    const statements = plan.pending[0]!.statements;

    // The DO blocks must survive the splitter intact -- they contain semicolons,
    // and a splitter that broke on those would deploy half a plpgsql body.
    // (A statement carries its leading comment block, so match on content.)
    const assertions = statements.filter((s) => s.includes('DO $$'));
    expect(assertions).toHaveLength(3);
    for (const assertion of assertions) {
      expect(assertion).toContain('RAISE EXCEPTION');
      expect(assertion.trimEnd().endsWith('END $$')).toBe(true);
      // Exactly one body per statement: two would mean the split failed.
      expect(assertion.split('DO $$')).toHaveLength(2);
    }

    // Nothing in the DDL may carry a bind placeholder: the runner passes these
    // statements with no params at all.
    for (const statement of statements) {
      expect(countPlaceholders(statement)).toBe(0);
    }

    // Every statement idempotent, so the every-deploy path is safe.
    const notIdempotent = statements.filter(
      (s) =>
        !/IF NOT EXISTS/i.test(s) &&
        !/CREATE OR REPLACE/i.test(s) &&
        !/ON CONFLICT/i.test(s) &&
        !s.includes('DO $$'),
    );
    expect(notIdempotent).toEqual([]);
  });

  it('declares no PostGIS type and calls no ST_ function', async () => {
    const sql = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../../postgres_sampling_v01.sql', import.meta.url), 'utf8'),
    );
    // The comments name ST_* and GEOGRAPHY deliberately -- they explain what was
    // dropped -- so strip every comment before checking, including trailing ones.
    const statements = buildPlan([{ id: 'p.sql', sql }], new Map(), 'p').pending[0]!.statements;
    const executable = statements.map(stripComments).join('\n');

    expect(executable).not.toMatch(/\bST_[A-Za-z]+\s*\(/);
    expect(executable).not.toMatch(/\bTO_GEOGRAPHY\b/i);
    // A type declaration, i.e. `COL geography,` or `geography(Point,4326)`.
    expect(executable).not.toMatch(/\b(geography|geometry)\s*[,(]/i);
    expect(executable).not.toMatch(/\bPOSTGIS\b/i);
    expect(executable).not.toMatch(/CREATE\s+EXTENSION/i);
  });

  it('preserves the RAW verbatim-payload anchor', async () => {
    const sql = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../../postgres_sampling_v01.sql', import.meta.url), 'utf8'),
    );
    // The content hash addresses the bytes as received. jsonb normalises key
    // order and drops duplicate keys, so a jsonb-only table could not reproduce
    // them. PAYLOAD_TEXT is what keeps sha256(bytes) checkable.
    expect(sql).toMatch(/PAYLOAD_TEXT\s+text\s+NOT NULL/);
    expect(sql).toMatch(/PAYLOAD\s+jsonb\s+NOT NULL/);
    expect(sql).toContain('SYNC_PAYLOAD_BYTES_MATCH');
    expect(sql).toMatch(/RAW_VALUES_TEXT\s+text/);
  });
});

describe('the mock-mode composition hazard', () => {
  it('is why isMockMode() must stop keying on SNOWFLAKE_ACCOUNT', async () => {
    // src/server/dev/mock-mode.ts is owned by server-endpoints, so this test
    // documents the defect rather than fixing it: with the Postgres backend
    // selected and no Snowflake credentials, isMockMode() returns true and every
    // endpoint that consults it serves fixtures -- so the Netlify database is
    // never reached. Recorded as an executable note, and it will start failing
    // the moment that file is corrected, which is the signal to delete this test.
    const previous = { ...process.env };
    try {
      delete process.env.SNOWFLAKE_ACCOUNT;
      delete process.env.MOCK_SNOWFLAKE;
      process.env.NETLIFY_DATABASE_URL = 'postgres://example/db';
      vi.resetModules();
      const [{ isMockMode }, { sqlBackend }] = await Promise.all([
        import('../../src/server/dev/mock-mode.js'),
        import('../../src/server/env.js'),
      ]);
      expect(sqlBackend()).toBe('postgres');
      expect(isMockMode()).toBe(true); // <- the hazard, in one line
    } finally {
      process.env = previous;
      vi.resetModules();
    }
  });
});
