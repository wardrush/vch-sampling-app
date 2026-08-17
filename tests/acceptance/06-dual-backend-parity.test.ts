/**
 * N2 · the sync spine on two backends.
 *
 * MVP/UAT storage is a Netlify database (Neon Postgres) and production is
 * Snowflake, so every statement `/sync/batch` and the derivation pipeline issue
 * now exists in two dialects. **There is no live database of either kind**, here
 * or in CI, so what can be established offline has to be established
 * deliberately:
 *
 *  1. **Every Postgres statement is a valid parameterised query** — driven
 *     through the *real* `PostgresClient`, which rewrites `?` → `$n`, refuses a
 *     placeholder/bind mismatch, splits `executeMulti`'s flat bind array by
 *     counting placeholders, and throws on the jsonb `?|`/`?&` operators. A
 *     transposed bind or a stray `?` fails here rather than at 2 a.m. in
 *     October.
 *  2. **No Snowflake-only syntax survives on the Postgres path** — no `MERGE`,
 *     no `PARSE_JSON`, no `CURRENT_TIMESTAMP()`, no `ST_*`.
 *  3. **Every column the parser writes exists in both DDL files.** This is the
 *     check that found `CURATED.SAMPLE_CONDITION` being stamped with
 *     `LAST_UPDATED_TS`, a column it has in neither file — a `sample_condition`
 *     batch would have failed on Snowflake too.
 *  4. **Skipped geospatial is visible, not silent.** The rules that could not
 *     run are named, the run is recorded, and the clean state is
 *     `screened_partial`.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PostgresClient, type PgExecutor, type PgQuery } from '../../src/shared/db/postgres/client.js';
import { countPlaceholders } from '../../src/shared/db/postgres/placeholders.js';
import { MemoryBlobStore } from '../../src/server/storage/blobs.js';
import { MediaTicketIssuer } from '../../src/server/media/tickets.js';
import { handleSyncBatch, rawRebuildSourceSql } from '../../src/server/sync/batch.js';
import {
  columnsFor,
  curatedMergeSql,
  mergeableEntityTypes,
  tableFor,
} from '../../src/server/sync/merge.js';
import { runDerivationPipeline } from '../../src/server/derive/pipeline.js';
import { DEFECT_CODE } from '../../src/shared/codes/index.js';
import { BOTH_DIALECTS, FakeSqlClient } from './support/fake-sql-client.js';
import type { SyncBatchRequest } from '../../src/shared/contract/sync.js';
import type { SqlDialect } from '../../src/shared/db/port.js';

// ---------------------------------------------------------------------------
// Harnesses
// ---------------------------------------------------------------------------

/** Records what the adapter actually sends: `$n` SQL plus its parameters. */
class RecordingExecutor implements PgExecutor {
  readonly queries: PgQuery[] = [];

  async query(query: PgQuery) {
    this.queries.push(query);
    return { fields: [], rows: [], rowCount: 0, command: 'INSERT' };
  }

  async transaction(queries: readonly PgQuery[]) {
    this.queries.push(...queries);
    return queries.map(() => ({ fields: [], rows: [], rowCount: 0, command: 'INSERT' }));
  }
}

function postgresHarness(): { client: PostgresClient; executor: RecordingExecutor } {
  const executor = new RecordingExecutor();
  return { client: new PostgresClient({ executor }), executor };
}

function batch(): SyncBatchRequest {
  return {
    sync_batch_id: '01J9BATCH000000000000000007',
    device_id: 'dev-1',
    app_version: '1.0.4',
    schema_version: '1.0',
    client_sent_ts: '2026-10-02T23:11:04Z',
    records: [
      { entity_type: 'field_visit', entity_id: 'v1', payload: { visit_id: 'v1', boundary_id: 'b1' } },
      {
        entity_type: 'sample_point',
        entity_id: 's1',
        payload: { sample_uid: 's1', visit_id: 'v1', lat: 47.9, lon: -103.2 },
      },
      {
        entity_type: 'sample_condition',
        entity_id: 'c1',
        payload: { condition_id: 'c1', sample_uid: 's1', condition_code: 'WET' },
      },
      {
        entity_type: 'media_meta',
        entity_id: 'm1',
        payload: { media_id: 'm1', sample_uid: 's1', content_hash: 'a'.repeat(64) },
      },
      // Device-raised: the mapping that writes no SYNC_BATCH_ID, because
      // CURATED.SAMPLE_DEFECT has no such column in either DDL.
      {
        entity_type: 'local_defect',
        entity_id: 'd1',
        payload: { defect_id: 'd1', sample_uid: 's1', defect_code: 'BARCODE_UNREAD' },
      },
    ],
  };
}

function syncDeps(client: PostgresClient, blobs: MemoryBlobStore) {
  return {
    snowflake: client,
    blobs,
    tickets: new MediaTicketIssuer({
      blobs,
      baseUrl: 'https://example.test',
      uploadSecret: 'upload-secret',
    }),
    derivation: { async trigger() {} },
  };
}

/** `$1…$n` actually referenced by a statement. */
function maxParamIndex(sql: string): number {
  let max = 0;
  for (const match of sql.matchAll(/\$(\d+)/g)) max = Math.max(max, Number(match[1]));
  return max;
}

const SNOWFLAKE_ONLY = [
  'MERGE INTO',
  'PARSE_JSON',
  'CURRENT_TIMESTAMP()',
  'CURRENT_USER()',
  'FLATTEN',
  'ARRAY_AGG',
  'QUALIFY',
  'TRY_TO_GEOGRAPHY',
];

function assertPostgresShaped(sql: string): void {
  for (const fragment of SNOWFLAKE_ONLY) expect(sql).not.toContain(fragment);
  // ST_WITHIN / ST_DISTANCE / ST_AZIMUTH — but not LAST_UPDATED_TS, which also
  // contains the letters ST_.
  expect(sql).not.toMatch(/\bST_[A-Z]/);
  // A bare `?` left in the text means the rewriter missed one.
  expect(sql).not.toContain('?');
}

// ---------------------------------------------------------------------------

describe('the Postgres write path is a valid parameterised query, statement by statement', () => {
  it('holds for every statement /sync/batch issues', async () => {
    const { client, executor } = postgresHarness();
    const blobs = new MemoryBlobStore();
    const request = batch();
    const rawBody = new TextEncoder().encode(JSON.stringify(request));

    const response = await handleSyncBatch(rawBody, request, syncDeps(client, blobs));

    // Per-record acknowledgement for every record, on this backend too.
    expect([...response.accepted].sort()).toEqual(['c1', 'd1', 'm1', 's1', 'v1']);
    expect(response.rejected).toEqual([]);

    // RAW first, then the entity writes in contract §5 order, then the batch row.
    const order = executor.queries.map((q) => q.sql.slice(0, 40).replace(/\s+/g, ' ').trim());
    expect(order[0]).toContain('INSERT INTO RAW.SYNC_PAYLOAD');
    expect(order.findIndex((s) => s.includes('CURATED.FIELD_VISIT'))).toBeLessThan(
      order.findIndex((s) => s.includes('CURATED.SAMPLE_POINT')),
    );

    for (const query of executor.queries) {
      // The adapter already threw if the counts disagreed; this pins the other
      // direction — a parameter supplied but never referenced.
      expect(query.params).toHaveLength(maxParamIndex(query.sql));
      assertPostgresShaped(query.sql);
    }
  });

  it('collapses a repeated client key instead of poisoning the statement', async () => {
    // `ON CONFLICT DO UPDATE` refuses to affect the same row twice in one
    // statement, and a batch that can never succeed would be retried by the
    // outbox forever. The outbox's own unique index means a conforming client
    // cannot produce this; a non-conforming one must not be able to jam a queue.
    const { client, executor } = postgresHarness();
    const request = batch();
    request.records.push({
      entity_type: 'sample_point',
      entity_id: 's1',
      payload: { sample_uid: 's1', visit_id: 'v1', lat: 48.1, lon: -103.4 },
    });
    const rawBody = new TextEncoder().encode(JSON.stringify(request));

    const response = await handleSyncBatch(rawBody, request, syncDeps(client, new MemoryBlobStore()));
    expect(response.rejected).toEqual([]);

    const samplePoint = executor.queries.find((q) => q.sql.includes('CURATED.SAMPLE_POINT'))!;
    const payloads = JSON.parse(String(samplePoint.params[1])) as Array<{ lat: number }>;
    expect(payloads).toHaveLength(1);
    // Last one wins, matching the outbox's own ON CONFLICT DO UPDATE.
    expect(payloads[0]!.lat).toBe(48.1);
    // And the SQL de-duplicates too, for the rebuild path where the array comes
    // out of RAW rather than out of this process.
    expect(samplePoint.sql).toContain('ROW_NUMBER() OVER');
  });

  it('holds for every statement the derivation pipeline issues', async () => {
    const { client, executor } = postgresHarness();

    const result = await runDerivationPipeline('batch-1', {
      snowflake: client,
      // Step 7's seam: the A7 harness is not ported yet (see the report), and
      // step 8 is what this test needs to reach.
      runRules: async () => 0,
    });

    expect(result.backend).toBe('postgres');
    for (const query of executor.queries) {
      expect(query.params).toHaveLength(maxParamIndex(query.sql));
      assertPostgresShaped(query.sql);
    }
  });

  it('holds for the rebuild path, which carries two binds per statement', () => {
    for (const entityType of mergeableEntityTypes()) {
      const sql = curatedMergeSql(entityType, rawRebuildSourceSql(entityType, 'postgres'), '?', 'postgres');
      // One for the batch id it re-stamps, one for the RAW payload hash.
      expect(countPlaceholders(sql)).toBe(2);
      assertPostgresShaped(sql.replace(/\?/g, '$0'));
    }
  });
});

describe('geospatial is deferred on Postgres, and says so', () => {
  it('skips the geographic steps and names the rules that could not run', async () => {
    const db = new FakeSqlClient('postgres');

    const result = await runDerivationPipeline('batch-1', {
      snowflake: db,
      runRules: async () => 0,
    });

    expect(result.geo_capability).toBe('none');
    expect(result.steps).toEqual(['geography', 'defect_rules', 'review_state']);
    expect(result.steps_skipped).toEqual(['point_in_polygon', 'trs', 'offset_from_plan']);
    // Both rules whose only input is a geospatial derivation. Silence here is
    // the failure this whole design is against.
    expect(result.rules_not_run).toEqual([
      DEFECT_CODE.POINT_OUTSIDE_BOUNDARY,
      DEFECT_CODE.OFFSET_EXCEEDED_NO_REASON,
    ]);
    expect(result.geo_derivation_state).toBe('deferred_no_geospatial');

    // No boundary defect is raised, because every row would get one.
    expect(
      db.statements.some((s) => s.binds.includes(DEFECT_CODE.POINT_OUTSIDE_BOUNDARY)),
    ).toBe(false);
    // GEOM_INVALID still fires: on this backend it is arithmetic, not geography.
    expect(db.statements.some((s) => s.binds.includes(DEFECT_CODE.GEOM_INVALID))).toBe(true);
  });

  it('stamps GEO_DERIVATION_STATE on every row it touched', async () => {
    const db = new FakeSqlClient('postgres');
    await runDerivationPipeline('batch-1', { snowflake: db, runRules: async () => 0 });

    const geography = db.matching('GEO_DERIVATION_STATE =');
    expect(geography).toHaveLength(2);
    // In-range coordinate: checked as far as this backend can, and no further.
    expect(geography[0]!.sql).toContain("'deferred_no_geospatial'");
    // Missing or out-of-range coordinate: checked, and the coordinate is bad.
    expect(geography[0]!.sql).toContain("'invalid_geometry'");
    expect(geography[1]!.sql).toContain("'invalid_geometry'");
  });

  it('writes screened_partial, never screened, and lets the CHECK constraint prove it', async () => {
    const db = new FakeSqlClient('postgres');
    const result = await runDerivationPipeline('batch-1', {
      snowflake: db,
      runRules: async () => 0,
    });

    expect(result.clean_review_state).toBe('screened_partial');
    const reviewState = db.matching('REVIEW_STATE = CASE')[0]!;
    // The clean state travels as a bind, so `SAMPLE_POINT_SCREENED_REQUIRES_GEO`
    // is the thing enforcing it rather than a literal in a string somewhere.
    expect(reviewState.binds[0]).toBe('screened_partial');
    expect(reviewState.sql).not.toContain("'screened'");
    expect(reviewState.sql).toContain("NOT IN ('accepted', 'rejected')");
  });

  it('records the run, with the skipped steps in it', async () => {
    const db = new FakeSqlClient('postgres');
    const result = await runDerivationPipeline('batch-1', {
      snowflake: db,
      runRules: async () => 3,
    });

    const run = db.matching('INSERT INTO CURATED.DERIVATION_RUN')[0];
    expect(run).toBeDefined();
    expect(run!.binds[0]).toBe(result.run_id);
    expect(run!.binds[1]).toBe('batch-1');
    expect(run!.binds[4]).toBe('partial');
    expect(run!.binds[5]).toBe('postgres');
    expect(run!.binds[6]).toBe('none');
    // An empty STEPS_SKIPPED on a run with GEO_CAPABILITY 'none' is a pipeline
    // bug, not a clean run.
    expect(JSON.parse(String(run!.binds[8]))).toEqual([
      'point_in_polygon',
      'trs',
      'offset_from_plan',
    ]);
    expect(JSON.parse(String(run!.binds[13])).rules_not_run).toHaveLength(2);
  });

  it('skips step 8 as well when the defect rules could not run', async () => {
    // The A7 harness still emits PARSE_JSON/FLATTEN/MERGE, so it does not run
    // on this backend yet. A review state written from a screening that never
    // happened is the exact lie the geo-assurance work exists to prevent, so
    // the rows stay `captured` and read as `awaiting_derivation`.
    const db = new FakeSqlClient('postgres');
    const result = await runDerivationPipeline('batch-1', { snowflake: db });

    expect(result.steps).toEqual(['geography']);
    expect(result.steps_skipped).toContain('defect_rules');
    expect(result.steps_skipped).toContain('review_state');
    expect(db.matching('REVIEW_STATE = CASE')).toHaveLength(0);
  });
});

describe('Snowflake behaviour is unchanged by the port', () => {
  it('still derives geography, boundary, TRS and offset, and records no run row', async () => {
    const db = new FakeSqlClient('snowflake');
    const result = await runDerivationPipeline('batch-1', {
      snowflake: db,
      harness: { rules: [] },
    });

    expect(result.steps_skipped).toEqual([]);
    expect(result.clean_review_state).toBe('screened');
    expect(db.matching('TRY_TO_GEOGRAPHY').length).toBeGreaterThan(0);
    expect(db.matching('ST_WITHIN').length).toBe(1);
    expect(db.matching('ST_DISTANCE').length).toBe(1);
    // GEO_DERIVATION_STATE has no Snowflake counterpart yet, so nothing writes
    // it there; neither does DERIVATION_RUN exist. Both are requested in
    // integration/requests-a.md.
    expect(db.matching('GEO_DERIVATION_STATE')).toHaveLength(0);
    expect(db.matching('CURATED.DERIVATION_RUN')).toHaveLength(0);
  });

  it('still writes MERGE, PARSE_JSON and CURRENT_TIMESTAMP() on the sync path', async () => {
    const db = new FakeSqlClient('snowflake');
    const blobs = new MemoryBlobStore();
    const request = batch();
    const rawBody = new TextEncoder().encode(JSON.stringify(request));

    await handleSyncBatch(rawBody, request, {
      snowflake: db,
      blobs,
      tickets: new MediaTicketIssuer({
        blobs,
        baseUrl: 'https://example.test',
        uploadSecret: 'upload-secret',
      }),
      derivation: { async trigger() {} },
    });

    expect(db.matching('MERGE INTO CURATED.').length).toBe(6); // 5 entities + SYNC_BATCH
    expect(db.matching('PARSE_JSON(?)').length).toBe(6); // 5 entities + RAW
    // RAW.SYNC_PAYLOAD has no PAYLOAD_TEXT column on Snowflake.
    expect(db.matching('PAYLOAD_TEXT')).toHaveLength(0);
  });
});

describe('every column the parser writes exists in the DDL', () => {
  const ddl = {
    postgres: readFileSync(new URL('../../postgres_sampling_v01.sql', import.meta.url), 'utf8'),
    snowflake:
      readFileSync(new URL('../../snowflake_sampling_v01.sql', import.meta.url), 'utf8') +
      readFileSync(new URL('../../snowflake_v02_addendum.sql', import.meta.url), 'utf8'),
  } satisfies Record<SqlDialect, string>;

  /** Column names declared for one table, from CREATE TABLE plus any ALTER. */
  function columnsInDdl(sql: string, table: string): Set<string> {
    const columns = new Set<string>();
    const create = new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?${table}\\s*\\(([\\s\\S]*?)\\n\\);`, 'i');
    const body = create.exec(sql)?.[1] ?? '';
    for (const line of body.split('\n')) {
      const match = /^\s{2,}([A-Z][A-Z0-9_]*)\s+[A-Za-z]/.exec(line);
      if (match && !/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)$/.test(match[1]!)) {
        columns.add(match[1]!);
      }
    }
    // The column name may sit on the next line — `snowflake_v02_addendum.sql`
    // writes several of them that way, EXIF_GPS_PRESENT among them.
    const alter = new RegExp(
      `ALTER TABLE ${table} ADD COLUMN\\s+(?:IF NOT EXISTS\\s+)?([A-Z][A-Z0-9_]*)`,
      'gi',
    );
    for (const match of sql.matchAll(alter)) columns.add(match[1]!.toUpperCase());
    return columns;
  }

  it.each(BOTH_DIALECTS)('holds for %s', (dialect) => {
    for (const entityType of mergeableEntityTypes()) {
      const table = tableFor(entityType);
      const declared = columnsInDdl(ddl[dialect], table);
      expect(declared.size).toBeGreaterThan(0);
      for (const column of columnsFor(entityType)) {
        expect({ table, column, declared: declared.has(column) }).toEqual({
          table,
          column,
          declared: true,
        });
      }
    }
  });

  it('does not stamp LAST_UPDATED on a table that has no such column', () => {
    // CURATED.SAMPLE_CONDITION, in both files. Stamping it unconditionally was
    // an invalid-identifier error on Snowflake as well as on Postgres, invisible
    // because nothing had ever run against a database.
    for (const dialect of BOTH_DIALECTS) {
      const sql = curatedMergeSql('sample_condition', 'SRC', '?', dialect);
      expect(sql).not.toContain('LAST_UPDATED_TS');
      expect(sql).not.toContain('LAST_UPDATED_BY');
    }
    // …and still does stamp the tables that do have them.
    expect(curatedMergeSql('sample_point', 'SRC', '?', 'postgres')).toContain('LAST_UPDATED_TS');
  });
});
