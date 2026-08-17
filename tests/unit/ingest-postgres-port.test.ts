/**
 * Netlify-database pass, ingest lane. Two things this file exists to prove:
 *
 *  1. Task A — boundary/geometry matching is *skipped, not failed* on a
 *     backend with no geospatial capability (or a capability-having backend
 *     whose boundary cache is empty), and the skip is visible rather than
 *     read as "checked and clean". Neither condition blocks a commit.
 *  2. Task B — `/ingest/commit` and `/ingest/retire` speak Postgres-flavoured
 *     SQL when the client reports Postgres capabilities: `INSERT … ON
 *     CONFLICT` instead of `MERGE`, `::jsonb` instead of `PARSE_JSON`/
 *     `VARIANT`, `CURRENT_TIMESTAMP` instead of `CURRENT_TIMESTAMP()`, a
 *     window-function subquery instead of `QUALIFY` — while the Snowflake
 *     path (the existing `FakeSnowflake` default) is provably unchanged.
 *
 * The headline deliverable (wave prompt, "Definition of done" §1): a
 * well-formed spreadsheet — every row carries `boundary_id_stated`, which the
 * ingest spec §3 lists as an optional-but-supported column and which
 * `fixtures/plan_import_12row.tsv` populates on every row — goes from
 * `validateRows` to `commitImport` to `status: 'committed'` with an EMPTY
 * `boundaries` array (an empty `BOUNDARY_CACHE`) and `capabilities.geospatial
 * === false`. That is `describe('the headline deliverable — …')` below.
 */
import { describe, it, expect } from 'vitest';
import { FakeSnowflake } from '../support/fake-snowflake.js';
import { MemoryBlobStore } from '../../src/server/storage/blobs.js';
import {
  validateRows,
  BOUNDARY_CHECK_SKIPPED_NO_GEOSPATIAL,
  BOUNDARY_CHECK_SKIPPED_EMPTY_CACHE,
  BOUNDARY_UNRESOLVED_NO_GEOSPATIAL,
  type ValidateBoundary,
} from '../../src/ingest/validate/index.js';
import { commitImport } from '../../src/ingest/commit/index.js';
import { retireImport } from '../../src/ingest/retire/index.js';
import { POSTGRES_CAPABILITIES } from '../../src/shared/db/port.js';
import type { SqlClient } from '../../src/shared/db/port.js';
import type {
  IngestCommitRequest,
  ParsedPlanRow,
  ValidatedPlanRow,
} from '../../src/shared/contract/ingest.js';

/**
 * `FakeSnowflake` (shared, unowned by this lane, and depended on by tests
 * this lane does not own — e.g. `tests/unit/schema-and-ingest.test.ts`, which
 * casts it straight to `SnowflakeClient` with no `dialect`/`capabilities`)
 * predates the SQL port and carries neither field. Rather than widen that
 * shared file — which is exactly the write `tests/acceptance/support/
 * fake-sql-client.ts` (a sibling lane's near-identical wrapper) explicitly
 * avoids for the same reason — this local, this-file-only wrapper adds the
 * two `SqlClient` fields the Postgres-path tests below need, and delegates
 * every method to the same recorder instance so `sf.statements`/`queueRows`
 * still work exactly as in every other ingest test.
 */
function asPostgresClient(sf: FakeSnowflake): SqlClient {
  return {
    dialect: 'postgres',
    capabilities: POSTGRES_CAPABILITIES,
    execute: (sql, opts) => sf.execute(sql, opts),
    executeMulti: (statements, opts) => sf.executeMulti(statements, opts),
  };
}

function row(overrides: Partial<ParsedPlanRow> = {}): ParsedPlanRow {
  return {
    source_row_no: 1,
    raw_values: { point: 'PT-001', lat: '47.5432', lon: '-99.1234' },
    plan_point_label: 'PT-001',
    lat_raw: '47.5432',
    lon_raw: '-99.1234',
    lat: 47.5432,
    lon: -99.1234,
    coord_format_detected: 'decimal',
    coord_fix_applied: null,
    boundary_id_stated: 'b-001',
    field_name: null,
    strata_label: 'D1_Clay Loam',
    elevation_class: 'A',
    sequence_no: 1,
    access_note: null,
    prior_sample_uid: null,
    extra: {},
    operation_text: null,
    contact_name_text: null,
    contact_phone_text: null,
    contact_email_text: null,
    ...overrides,
  };
}

const boundaryB001: ValidateBoundary = {
  boundary_id: 'b-001',
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [-99.2, 47.5],
        [-99.1, 47.5],
        [-99.1, 47.6],
        [-99.2, 47.6],
        [-99.2, 47.5],
      ],
    ],
  },
  centroid_lat: 47.55,
  centroid_lon: -99.15,
};

describe('Task A — boundary/geometry matching is skipped, not failed', () => {
  it('never blocks a commit when the backend has no geospatial capability', async () => {
    const result = await validateRows(
      { period_code: 'F26', project_id: null, rows: [row()] },
      {
        boundaries: [], // an empty BOUNDARY_CACHE
        existingLabelsByBoundary: new Map(),
        findOperationCandidates: async () => [],
        findContactCandidates: async () => [],
        capabilities: POSTGRES_CAPABILITIES,
      },
    );
    const validated = result.rows[0]!;
    expect(validated.row_status).not.toBe('blocked');
    expect(validated.row_status).toBe('ready');
    // Skipped is VISIBLE -- not silently read as checked-and-clean.
    expect(validated.validation_codes).toContain(BOUNDARY_CHECK_SKIPPED_NO_GEOSPATIAL);
    expect(validated.validation_codes).not.toContain('POINT_OUTSIDE_BOUNDARY');
    // The stated boundary is trusted when geometry cannot verify it.
    expect(validated.boundary_id_resolved).toBe('b-001');
  });

  it('treats "capability present but cache empty" as a distinct, equally non-blocking condition', async () => {
    const result = await validateRows(
      { period_code: 'F26', project_id: null, rows: [row()] },
      {
        boundaries: [], // capable backend, nothing loaded into the cache yet
        existingLabelsByBoundary: new Map(),
        findOperationCandidates: async () => [],
        findContactCandidates: async () => [],
        capabilities: { ...POSTGRES_CAPABILITIES, geospatial: true },
      },
    );
    const validated = result.rows[0]!;
    expect(validated.row_status).not.toBe('blocked');
    expect(validated.validation_codes).toContain(BOUNDARY_CHECK_SKIPPED_EMPTY_CACHE);
    expect(validated.validation_codes).not.toContain(BOUNDARY_CHECK_SKIPPED_NO_GEOSPATIAL);
  });

  it('flags (never blocks) a row with no stated boundary either, and says so', async () => {
    const result = await validateRows(
      { period_code: 'F26', project_id: null, rows: [row({ boundary_id_stated: null })] },
      {
        boundaries: [],
        existingLabelsByBoundary: new Map(),
        findOperationCandidates: async () => [],
        findContactCandidates: async () => [],
        capabilities: POSTGRES_CAPABILITIES,
      },
    );
    const validated = result.rows[0]!;
    expect(validated.row_status).toBe('flagged');
    expect(validated.row_status).not.toBe('blocked');
    expect(validated.validation_codes).toContain(BOUNDARY_UNRESOLVED_NO_GEOSPATIAL);
    expect(validated.boundary_id_resolved).toBeNull();
  });

  it('every caller that omits `capabilities` keeps full point-in-polygon behaviour (backward compatible)', async () => {
    const result = await validateRows(
      { period_code: 'F26', project_id: null, rows: [row({ lat: 40, lon: -100, boundary_id_stated: null })] },
      {
        boundaries: [boundaryB001],
        existingLabelsByBoundary: new Map(),
        findOperationCandidates: async () => [],
        findContactCandidates: async () => [],
        // no `capabilities` field at all
      },
    );
    expect(result.rows[0]!.row_status).toBe('flagged');
    expect(result.rows[0]!.validation_codes).toContain('POINT_OUTSIDE_BOUNDARY');
  });
});

const actor = { ref: 'thane', kind: 'token' as const, ip: '203.0.113.1', user_agent: 'test' };

function commitRequest(rows: ParsedPlanRow[], validated: ValidatedPlanRow[]): IngestCommitRequest {
  return {
    period_code: 'F26',
    project_id: 'proj-1',
    mapping: { plan_point_label: 'point', lat: 'lat', lon: 'lon', boundary_id: 'boundary_id' },
    raw_file: {
      content_hash: 'ab'.repeat(32),
      original_filename: 'points.tsv',
      mime_type: 'text/tab-separated-values',
      bytes: 200,
      source_kind: 'file_upload',
      content_b64: Buffer.from('point\tlat\tlon\n').toString('base64'),
    },
    rows,
    validated,
  };
}

describe('Task B — /ingest/commit speaks Postgres SQL on a Postgres client', () => {
  it('uses INSERT … ON CONFLICT, ::jsonb and bare CURRENT_TIMESTAMP — never MERGE, PARSE_JSON or ST_*', async () => {
    const sf = new FakeSnowflake();
    sf.queueRows([], []); // no existing import
    sf.queueRows([], []); // no prior plans

    await commitImport(
      commitRequest(
        [row()],
        [{ source_row_no: 1, boundary_id_resolved: 'b-001', row_status: 'ready' } as never],
      ),
      { snowflake: asPostgresClient(sf), blobs: new MemoryBlobStore(), actor, ipHashSalt: 'salt' },
    );

    const write = sf.statements.at(-1)!.sql;
    expect(write).not.toMatch(/MERGE INTO/i);
    expect(write).not.toMatch(/PARSE_JSON/i);
    expect(write).not.toMatch(/QUALIFY/i);
    expect(write).not.toMatch(/\bST_[A-Z]+\(/); // no ST_ASGEOJSON(...), ST_CENTROID(...), etc.
    expect(write).not.toMatch(/TRY_TO_GEOGRAPHY/);
    expect(write).not.toMatch(/CURRENT_TIMESTAMP\(\)/);
    expect(write).not.toMatch(/PLANNED_GEOG/);
    expect(write).toMatch(/ON CONFLICT/);
    expect(write).toMatch(/::jsonb/);
    expect(write).toMatch(/CURRENT_TIMESTAMP(?!\()/);
  });

  it('the Snowflake path is provably unchanged: still MERGE, PARSE_JSON, CURRENT_TIMESTAMP()', async () => {
    // Plain `FakeSnowflake().asClient()` — the same fake every other ingest
    // test in this repo already uses, with no `dialect`/`capabilities` of its
    // own, so this also proves the defensive default (`capsOf()` in
    // `src/ingest/commit/index.ts`) resolves to full Snowflake behaviour.
    const sf = new FakeSnowflake();
    sf.queueRows([], []);
    sf.queueRows([], []);

    await commitImport(
      commitRequest(
        [row()],
        [{ source_row_no: 1, boundary_id_resolved: 'b-001', row_status: 'ready' } as never],
      ),
      { snowflake: sf.asClient(), blobs: new MemoryBlobStore(), actor, ipHashSalt: 'salt' },
    );

    const write = sf.statements.at(-1)!.sql;
    expect(write).toMatch(/MERGE INTO/);
    expect(write).toMatch(/PARSE_JSON/);
    expect(write).toMatch(/CURRENT_TIMESTAMP\(\)/);
  });

  it('loadPriorPlans uses a window-function subquery instead of QUALIFY on Postgres', async () => {
    const sf = new FakeSnowflake();
    sf.queueRows([], []); // no existing import
    sf.queueRows(['BOUNDARY_ID', 'PLAN_ID', 'PLAN_VERSION'], [['b-001', 'plan-old', '2']]);

    await commitImport(
      commitRequest(
        [row()],
        [{ source_row_no: 1, boundary_id_resolved: 'b-001', row_status: 'ready' } as never],
      ),
      { snowflake: asPostgresClient(sf), blobs: new MemoryBlobStore(), actor, ipHashSalt: 'salt' },
    );

    const priorPlansQuery = sf.statements[1]!.sql; // findExistingImport is [0], loadPriorPlans is [1]
    expect(priorPlansQuery).toMatch(/ROW_NUMBER\(\) OVER/);
    expect(priorPlansQuery).not.toMatch(/QUALIFY/);
  });
});

describe('Task B — /ingest/retire speaks Postgres SQL on a Postgres client', () => {
  it('drops the CURRENT_TIMESTAMP() parens and PARSE_JSON on Postgres', async () => {
    const sf = new FakeSnowflake();
    sf.queueRows(['STATUS', 'PLAN_IDS'], [['committed', '["plan-1"]']]); // findImport
    sf.queueRows(['COUNT(*)'], [['0']]); // countSampledPoints

    await retireImport(
      { import_id: 'import-1', reason: 'test' },
      { snowflake: asPostgresClient(sf), actor, ipHashSalt: 'salt' },
    );

    const write = sf.statements.at(-1)!.sql;
    expect(write).not.toMatch(/CURRENT_TIMESTAMP\(\)/);
    expect(write).toMatch(/CURRENT_TIMESTAMP(?!\()/);
    expect(write).not.toMatch(/PARSE_JSON/);
    expect(write).toMatch(/::jsonb/);
  });
});

describe('the headline deliverable — a well-formed spreadsheet reaches committed with an empty BOUNDARY_CACHE and no geospatial capability', () => {
  it('validates and commits a 12-row-style import end to end on Postgres capabilities', async () => {
    // Every row carries boundary_id_stated, matching fixtures/plan_import_12row.tsv
    // (spec §3: boundary_id is optional but supported, and the canonical fixture
    // populates it on every row). No other faults, so this is the clean path --
    // the deliverable is that it reaches committed, not that fault handling works
    // (that is covered by the Task A tests above and the existing commit tests).
    const rows: ParsedPlanRow[] = Array.from({ length: 8 }, (_, i) =>
      row({ source_row_no: i + 1, plan_point_label: `PT-${String(i + 1).padStart(3, '0')}` }),
    );

    const validateResult = await validateRows(
      { period_code: 'F26', project_id: null, rows },
      {
        boundaries: [], // empty BOUNDARY_CACHE
        existingLabelsByBoundary: new Map(),
        findOperationCandidates: async () => [],
        findContactCandidates: async () => [],
        capabilities: POSTGRES_CAPABILITIES, // no geospatial
      },
    );

    expect(validateResult.summary.rows_blocked).toBe(0);
    expect(validateResult.summary.rows_ready).toBe(8);
    for (const r of validateResult.rows) {
      expect(r.boundary_id_resolved).toBe('b-001');
      expect(r.validation_codes).toContain(BOUNDARY_CHECK_SKIPPED_NO_GEOSPATIAL);
    }

    const sf = new FakeSnowflake();
    sf.queueRows([], []); // no existing import
    sf.queueRows([], []); // no prior plans

    const commitResult = await commitImport(commitRequest(rows, validateResult.rows), {
      snowflake: asPostgresClient(sf),
      blobs: new MemoryBlobStore(),
      actor,
      ipHashSalt: 'salt',
    });

    expect(commitResult.status).toBe('committed');
    expect(commitResult.rows_blocked).toBe(0);
    expect(commitResult.rows_committed).toBe(8);
    expect(commitResult.plan_ids).toHaveLength(1);

    const write = sf.statements.at(-1)!.sql;
    expect(write).not.toMatch(/MERGE INTO/);
    expect(write).toContain('CURATED.PLAN_IMPORT_ROW');
    expect(write).toContain('CURATED.SAMPLE_PLAN_POINT');
    expect(write).toContain('CURATED.AUDIT_EVENT');
  });
});
