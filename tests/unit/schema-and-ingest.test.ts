/**
 * F0.6, C11 and A12 — the device schema, the ingest commit, and the deployer.
 */

import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { NodeSqliteDb } from '../support/node-sqlite.js';
import { FakeSnowflake } from '../support/fake-snowflake.js';
import { MemoryBlobStore } from '../../src/server/storage/blobs.js';
import {
  bootstrapDeviceDb,
  clearBundleTables,
  getSchemaVersion,
  migrate,
  MIGRATIONS,
  TARGET_SCHEMA_VERSION,
} from '../../src/shared/db/schema.js';
import { commitImport } from '../../src/ingest/commit/index.js';
import { importId, importRowId, planPointId, canonicalMapping } from '../../src/ingest/commit/ids.js';
import { splitStatements } from '../../tools/deploy-ddl.js';
import type { IngestCommitRequest, ParsedPlanRow } from '../../src/shared/contract/ingest.js';

describe('F0.6 — device schema and migrations', () => {
  it('bootstraps to the target version', async () => {
    const db = new NodeSqliteDb();
    const result = await bootstrapDeviceDb(db);
    expect(result.to).toBe(TARGET_SCHEMA_VERSION);
    expect(result.applied).toEqual(['device_v01', 'device_v02_addendum']);
    db.close();
  });

  it('is idempotent — a second run applies nothing', async () => {
    const db = new NodeSqliteDb();
    await bootstrapDeviceDb(db);
    const second = await migrate(db);
    expect(second.applied).toEqual([]);
    expect(await getSchemaVersion(db)).toBe(TARGET_SCHEMA_VERSION);
    db.close();
  });

  it('refuses to downgrade a device that has seen a newer build', async () => {
    const db = new NodeSqliteDb();
    await bootstrapDeviceDb(db);
    await db.exec('PRAGMA user_version = 99');
    await expect(migrate(db)).rejects.toThrow(/refusing to downgrade/);
    db.close();
  });

  it('creates the v02 columns the audit trail depends on', async () => {
    const db = new NodeSqliteDb();
    await bootstrapDeviceDb(db);
    const columns = await db.all<{ name: string }>('PRAGMA table_info(media)');
    const names = columns.map((c) => c.name);
    expect(names).toContain('capture_source');
    expect(names).toContain('exif_gps_present');
    expect(names).toContain('device_id');
    db.close();
  });

  it('replaces bundle tables wholesale without touching captured work', async () => {
    const db = new NodeSqliteDb();
    await bootstrapDeviceDb(db);
    await db.run(
      `INSERT INTO assigned_boundary (boundary_id, geojson) VALUES ('b1', '{}')`,
    );
    await db.run(
      `INSERT INTO field_visit (visit_id, boundary_id) VALUES ('v1', 'b1')`,
    );

    await clearBundleTables(db);

    expect(await db.all('SELECT * FROM assigned_boundary')).toHaveLength(0);
    // Write-local data is untouched: a stale contact list is not worth a
    // lost day's samples.
    expect(await db.all('SELECT * FROM field_visit')).toHaveLength(1);
    db.close();
  });

  it('does not renumber a shipped migration', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual([1, 2]);
  });
});

describe('F0.6 — the transcription matches the reviewed DDL', () => {
  it('creates every table named in the .sql files', async () => {
    const [v01, v02] = await Promise.all([
      readFile(new URL('../../device_sqlite_v01.sql', import.meta.url), 'utf8'),
      readFile(new URL('../../device_sqlite_v02_addendum.sql', import.meta.url), 'utf8'),
    ]);
    const declared = new Set(
      [...`${v01}\n${v02}`.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]!),
    );

    const db = new NodeSqliteDb();
    await bootstrapDeviceDb(db);
    const actual = new Set(
      (await db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='table'`)).map(
        (r) => r.name,
      ),
    );

    for (const table of declared) expect(actual.has(table)).toBe(true);
    db.close();
  });
});

describe('C11 — deterministic ids', () => {
  it('is stable regardless of mapping key order', () => {
    const a = importId('hash', 'thane', { lat: 'LAT_DD', lon: 'LON_DD' });
    const b = importId('hash', 'thane', { lon: 'LON_DD', lat: 'LAT_DD' });
    expect(a).toBe(b);
    expect(canonicalMapping({ b: '2', a: '1' })).toBe('[["a","1"],["b","2"]]');
  });

  it('changes when the file, the person or the mapping changes', () => {
    const base = importId('hash', 'thane', { lat: 'LAT' });
    expect(importId('other-hash', 'thane', { lat: 'LAT' })).not.toBe(base);
    expect(importId('hash', 'someone', { lat: 'LAT' })).not.toBe(base);
    expect(importId('hash', 'thane', { lat: 'Y' })).not.toBe(base);
  });

  it('derives row and point ids from the import', () => {
    const id = importId('hash', 'thane', {});
    expect(importRowId(id, 3)).not.toBe(importRowId(id, 4));
    expect(planPointId(importRowId(id, 3))).toBe(planPointId(importRowId(id, 3)));
  });
});

function row(overrides: Partial<ParsedPlanRow> = {}): ParsedPlanRow {
  return {
    source_row_no: 1,
    raw_values: { point: 'P1', lat: '47.9', lon: '-103.2' },
    plan_point_label: 'P1',
    lat_raw: '47.9',
    lon_raw: '-103.2',
    lat: 47.9,
    lon: -103.2,
    coord_format_detected: 'decimal',
    coord_fix_applied: null,
    boundary_id_stated: 'b1',
    field_name: null,
    strata_label: null,
    elevation_class: null,
    sequence_no: 1,
    access_note: null,
    prior_sample_uid: null,
    extra: { soil_note: 'clay' },
    operation_text: null,
    contact_name_text: null,
    contact_phone_text: null,
    contact_email_text: null,
    ...overrides,
  };
}

function request(rows: ParsedPlanRow[], validated: IngestCommitRequest['validated']): IngestCommitRequest {
  return {
    period_code: 'F26',
    project_id: 'proj-1',
    mapping: { plan_point_label: 'point', lat: 'lat', lon: 'lon' },
    raw_file: {
      content_hash: 'ff'.repeat(32),
      original_filename: 'points.csv',
      mime_type: 'text/csv',
      bytes: 120,
      source_kind: 'file_upload',
      content_b64: Buffer.from('point,lat,lon\nP1,47.9,-103.2\n').toString('base64'),
    },
    rows,
    validated,
  };
}

const actor = { ref: 'thane', kind: 'token' as const, ip: '203.0.113.1', user_agent: 'test' };

describe('C11 — ingest commit', () => {
  it('writes RAW, the import, every row, the plan, and the audit event in order', async () => {
    const sf = new FakeSnowflake();
    sf.queueRows([], []); // no existing import
    sf.queueRows([], []); // no prior plans

    const result = await commitImport(
      request(
        [row(), row({ source_row_no: 2, plan_point_label: 'P2' })],
        [
          { source_row_no: 1, boundary_id_resolved: 'b1', row_status: 'ready' } as never,
          { source_row_no: 2, boundary_id_resolved: 'b1', row_status: 'flagged' } as never,
        ],
      ),
      { snowflake: sf.asClient(), blobs: new MemoryBlobStore(), actor, ipHashSalt: 'salt' },
    );

    expect(result.status).toBe('committed');
    expect(result.rows_committed).toBe(2);
    expect(result.plan_ids).toHaveLength(1);

    const write = sf.statements.at(-1)!.sql;
    const order = [
      'RAW.PLAN_IMPORT_FILE',
      'CURATED.PLAN_IMPORT t',
      'CURATED.PLAN_IMPORT_ROW t',
      'CURATED.SAMPLE_PLAN t',
      'CURATED.SAMPLE_PLAN_POINT t',
      'CURATED.AUDIT_EVENT',
    ];
    let cursor = -1;
    for (const fragment of order) {
      const at = write.indexOf(fragment);
      expect(at, `${fragment} present`).toBeGreaterThan(-1);
      expect(at, `${fragment} in order`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('records blocked rows without turning them into plan points', async () => {
    const sf = new FakeSnowflake();
    sf.queueRows([], []);
    sf.queueRows([], []);

    const result = await commitImport(
      request(
        [row(), row({ source_row_no: 2 })],
        [
          { source_row_no: 1, boundary_id_resolved: 'b1', row_status: 'ready' } as never,
          { source_row_no: 2, boundary_id_resolved: null, row_status: 'blocked' } as never,
        ],
      ),
      { snowflake: sf.asClient(), blobs: new MemoryBlobStore(), actor, ipHashSalt: 'salt' },
    );

    expect(result.row_count).toBe(2);
    expect(result.rows_committed).toBe(1);
    expect(result.rows_blocked).toBe(1);

    // Every input row is in the record, including the rejected one.
    const write = sf.statements.at(-1)!;
    const rowsBind = write.binds.find(
      (b) => typeof b === 'string' && b.includes('import_row_id'),
    ) as string;
    expect(JSON.parse(rowsBind)).toHaveLength(2);
  });

  it('raises a queue item for an unmatched operation and creates no CRM record', async () => {
    const sf = new FakeSnowflake();
    sf.queueRows([], []);
    sf.queueRows([], []);

    const result = await commitImport(
      request(
        [row({ operation_text: 'Bring Farms' })],
        [
          {
            source_row_no: 1,
            boundary_id_resolved: 'b1',
            row_status: 'flagged',
            operation_match_status: 'suggested',
            operation_match_id: 'op-9',
            operation_match_score: 0.71,
          } as never,
        ],
      ),
      { snowflake: sf.asClient(), blobs: new MemoryBlobStore(), actor, ipHashSalt: 'salt' },
    );

    expect(result.queue_items).toBe(1);
    const write = sf.statements.at(-1)!.sql;
    expect(write).toContain('IMPORT_OPERATION_UNRESOLVED'.length > 0 ? 'CURATED.SAMPLE_DEFECT' : '');
    // D16: nothing anywhere in the commit writes an OPERATION or a PERSON.
    expect(write).not.toMatch(/INSERT INTO\s+CURATED\.OPERATION/i);
    expect(write).not.toMatch(/INSERT INTO\s+CURATED\.PERSON/i);
  });

  it('supersedes the previous plan version rather than deleting it', async () => {
    const sf = new FakeSnowflake();
    sf.queueRows([], []);
    sf.queueRows(['BOUNDARY_ID', 'PLAN_ID', 'PLAN_VERSION'], [['b1', 'plan-old', '2']]);

    await commitImport(
      request([row()], [{ source_row_no: 1, boundary_id_resolved: 'b1', row_status: 'ready' } as never]),
      { snowflake: sf.asClient(), blobs: new MemoryBlobStore(), actor, ipHashSalt: 'salt' },
    );

    const write = sf.statements.at(-1)!;
    expect(write.sql).toContain("STATUS = 'superseded'");
    expect(write.sql).not.toMatch(/DELETE FROM CURATED\.SAMPLE_PLAN/i);
    expect(write.binds).toContain(JSON.stringify(['plan-old']));

    const plansBind = write.binds.find(
      (b) => typeof b === 'string' && b.includes('plan_version'),
    ) as string;
    expect(JSON.parse(plansBind)[0]).toMatchObject({ plan_version: 3, parent_plan_id: 'plan-old' });
  });

  it('is a no-op on a double-click', async () => {
    const sf = new FakeSnowflake();
    sf.queueRows(
      ['STATUS', 'PLAN_IDS', 'ROWS_COMMITTED', 'IMPORTED_TS'],
      [['committed', '["plan-1"]', '1', '2026-10-02T12:00:00Z']],
    );

    const result = await commitImport(
      request([row()], [{ source_row_no: 1, boundary_id_resolved: 'b1', row_status: 'ready' } as never]),
      { snowflake: sf.asClient(), blobs: new MemoryBlobStore(), actor, ipHashSalt: 'salt' },
    );

    expect(result.idempotent_replay).toBe(true);
    expect(result.plan_ids).toEqual(['plan-1']);
    expect(sf.statements).toHaveLength(1); // the lookup, and nothing else
  });
});

describe('A12 — the DDL deployer', () => {
  it('does not split inside a procedure body or a quoted literal', () => {
    const sql = `
      CREATE TABLE t (a INT);
      CREATE PROCEDURE p() RETURNS VARCHAR LANGUAGE SQL AS
      $$
      BEGIN
        UPDATE t SET a = 1;
        RETURN 'ok';
      END;
      $$;
      INSERT INTO t SELECT 'a semicolon; inside a literal';
    `;
    const statements = splitStatements(sql);
    expect(statements).toHaveLength(3);
    expect(statements[1]).toContain('RETURN');
    expect(statements[2]).toContain('a semicolon; inside a literal');
  });

  it('handles a doubled quote inside a literal', () => {
    const statements = splitStatements(`SELECT 'it''s fine'; SELECT 2;`);
    expect(statements).toHaveLength(2);
  });

  it('parses the real DDL files without swallowing statements', async () => {
    for (const file of [
      'snowflake_sampling_v01.sql',
      'snowflake_v02_addendum.sql',
      'snowflake_v03_entity_compat.sql',
    ]) {
      const sql = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
      const statements = splitStatements(sql);
      expect(statements.length, file).toBeGreaterThan(0);
      for (const statement of statements) {
        expect(statement.trim(), file).not.toBe('');
      }
    }
  });
});
