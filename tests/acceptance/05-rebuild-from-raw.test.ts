/**
 * A13 · v02 §11 criterion 5.
 *
 * *`CURATED` is dropped and rebuilt entirely from `RAW`, byte-identical.*
 *
 * The full criterion needs a database. What can be established without one —
 * and what actually decides whether the criterion holds a year from now — is
 * that **there is only one parse**. Two code paths that agree today diverge the
 * first time someone adds a column to the live path and forgets the rebuild
 * path, and the divergence is invisible until someone tries the rebuild.
 *
 * So the test asserts the structural property: the live path and the rebuild
 * path produce the same projection, differing only in where the rows come from.
 * **On both backends**, because the Netlify database made "one parse" into a
 * claim about two dialects rather than one.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryBlobStore } from '../../src/server/storage/blobs.js';
import { MediaTicketIssuer } from '../../src/server/media/tickets.js';
import { handleSyncBatch } from '../../src/server/sync/batch.js';
import type { SyncBatchRequest } from '../../src/shared/contract/sync.js';
import {
  curatedMergeSql,
  curatedWriteForPayload,
  mergeableEntityTypes,
} from '../../src/server/sync/merge.js';
import { rawRebuildSourceSql, rebuildCuratedFromRaw } from '../../src/server/sync/batch.js';
import { syntaxFor } from '../../src/server/sync/dialect.js';
import { FakeSqlClient, BOTH_DIALECTS } from './support/fake-sql-client.js';
import type { SqlDialect } from '../../src/shared/db/port.js';

/** Everything from the projection's `SELECT` to its source — the parse itself. */
function projection(sql: string, dialect: SqlDialect): string {
  const [open, close] =
    dialect === 'postgres'
      ? ['FROM (\n  SELECT ', 'FROM jsonb_array_elements']
      : ['USING (\n  SELECT ', 'FROM TABLE(FLATTEN'];
  const start = sql.indexOf(open);
  const end = sql.indexOf(close);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe.each(BOTH_DIALECTS)('criterion 5 on %s — CURATED is rebuildable from RAW', (dialect) => {
  const syntax = syntaxFor(dialect);

  it('uses one parse for the live path and the rebuild path', () => {
    for (const entityType of mergeableEntityTypes()) {
      const live = curatedMergeSql(entityType, syntax.parseJson('?'), '?', dialect);
      const rebuild = curatedMergeSql(
        entityType,
        rawRebuildSourceSql(entityType, dialect),
        '?',
        dialect,
      );

      // Same columns, same casts, same order. Only the source differs.
      expect(projection(rebuild, dialect)).toBe(projection(live, dialect));
    }
  });

  it('never writes a derived column from a device payload', () => {
    const derived = [
      'GEOG',
      'BOUNDARY_ID',
      'TRS_CANONICAL',
      'OFFSET_FROM_PLAN_M',
      'BEARING_FROM_PLAN_DEG',
      'REVIEW_STATE',
      'GEO_DERIVATION_STATE',
      'BARCODE_NORM',
    ];
    const sql = curatedMergeSql('sample_point', syntax.parseJson('?'), '?', dialect);
    const insertClause =
      dialect === 'postgres'
        ? sql.slice(sql.indexOf('AS t\n'), sql.indexOf('SELECT '))
        : sql.slice(sql.indexOf('INSERT ('), sql.indexOf('VALUES ('));

    for (const column of derived) {
      expect(insertClause).not.toContain(`${column},`);
      expect(insertClause).not.toContain(`${column})`);
    }
  });

  it('refuses to overwrite a sample an analyst has accepted', () => {
    const sql = curatedMergeSql('sample_point', syntax.parseJson('?'), '?', dialect);
    expect(sql).toContain("COALESCE(t.REVIEW_STATE, 'captured') <> 'accepted'");
  });

  it('stamps every merged row with its sync batch, where the table has the column', () => {
    for (const entityType of mergeableEntityTypes()) {
      const sql = curatedMergeSql(entityType, syntax.parseJson('?'), '?', dialect);
      // Asserting the *insert list*, not merely that the string appears — the
      // projection always names SYNC_BATCH_ID to keep the bind order uniform.
      const insertList =
        dialect === 'postgres'
          ? sql.slice(sql.indexOf('AS t\n'), sql.indexOf('\nSELECT '))
          : sql.slice(sql.indexOf('INSERT ('), sql.indexOf('VALUES ('));
      // CURATED.SAMPLE_DEFECT has no SYNC_BATCH_ID column in either DDL; see
      // `batchStamped` in merge.ts and the request to schema-steward.
      expect(insertList.includes('SYNC_BATCH_ID')).toBe(entityType !== 'local_defect');
    }
  });

  it('binds the batch id before the payload, because the SQL names it first', () => {
    // The projection that stamps SYNC_BATCH_ID precedes the FROM that parses
    // the payload, and binds are positional on both backends. Transposing them
    // puts a JSON array in SYNC_BATCH_ID and a batch id through the JSON parse.
    const write = curatedWriteForPayload('sample_point', '[{"sample_uid":"s1"}]', 'batch-1', dialect);
    expect(write.sql.indexOf('? AS SYNC_BATCH_ID')).toBeLessThan(
      write.sql.indexOf(syntax.parseJson('?')),
    );
    expect(write.binds).toEqual(['batch-1', '[{"sample_uid":"s1"}]']);
  });

  it('replays each RAW payload in arrival order, under its original batch id', async () => {
    const db = new FakeSqlClient(dialect);
    // The RECEIVED_TS-ordered listing the rebuild drives from.
    db.queueRows(
      ['SYNC_BATCH_ID', 'RAW_PAYLOAD_HASH'],
      [
        ['batch-early', 'hash-early'],
        ['batch-late', 'hash-late'],
      ],
    );

    await rebuildCuratedFromRaw(db, ['sample_point', 'field_visit'], undefined);

    const listing = db.statements[0]!;
    expect(listing.sql).toContain('ORDER BY RECEIVED_TS');

    const writes = db.statements.slice(1);
    // Parents before children within each payload, payloads in arrival order.
    expect(writes.map((s) => s.binds)).toEqual([
      ['batch-early', 'hash-early'],
      ['batch-early', 'hash-early'],
      ['batch-late', 'hash-late'],
      ['batch-late', 'hash-late'],
    ]);
    expect(writes[0]!.sql).toContain('CURATED.FIELD_VISIT');
    expect(writes[1]!.sql).toContain('CURATED.SAMPLE_POINT');
    // Re-stamped with the batch it arrived under, so the derivation pipeline —
    // which is keyed on SYNC_BATCH_ID — can be re-run over the rebuilt rows.
    expect(writes[0]!.sql).toContain('? AS SYNC_BATCH_ID');
  });
});

describe('criterion 5 — the hash addresses the bytes, not the stored row', () => {
  /**
   * `RAW.SYNC_PAYLOAD.PAYLOAD` is `VARIANT` on Snowflake and `jsonb` on
   * Postgres. **Both** normalise key order and drop duplicate keys, so neither
   * can be re-serialised back to the bytes that were hashed — the Snowflake row
   * was never byte-faithful either. `PAYLOAD_TEXT` exists so that
   * `sha256(PAYLOAD_TEXT) = RAW_PAYLOAD_HASH` is a *checkable statement*, and
   * this is the check: over the binds the write actually issues.
   */
  it('stores text that hashes back to RAW_PAYLOAD_HASH, from one decode', async () => {
    const db = new FakeSqlClient('postgres');
    const blobs = new MemoryBlobStore();
    // Duplicate key and unsorted keys: a shape jsonb provably cannot give back.
    const body = new TextEncoder().encode(
      '{"records":[],"sync_batch_id":"b1","device_id":"d1","app_version":"1.0.4",' +
        '"schema_version":"1.0","client_sent_ts":"2026-10-02T23:11:04Z","z":1,"z":2}',
    );
    const request = JSON.parse(new TextDecoder().decode(body)) as SyncBatchRequest;

    const response = await handleSyncBatch(body, request, {
      snowflake: db,
      blobs,
      tickets: new MediaTicketIssuer({
        blobs,
        baseUrl: 'https://example.test',
        uploadSecret: 'upload-secret',
      }),
      derivation: { async trigger() {} },
    });

    const raw = db.matching('RAW.SYNC_PAYLOAD')[0]!;
    const [hashBind, , , payloadText, payloadJson, bytes] = raw.binds as string[];

    expect(hashBind).toBe(response.raw_payload_hash);
    expect(createHash('sha256').update(String(payloadText)).digest('hex')).toBe(hashBind);
    // PAYLOAD and PAYLOAD_TEXT come from the same decode in the same statement,
    // which is what the octet_length CHECK in the DDL guards.
    expect(payloadJson).toBe(payloadText);
    expect(Number(bytes)).toBe(Buffer.byteLength(String(payloadText), 'utf8'));
    // And what the object store holds is the original bytes, not the text.
    expect(await blobs.get(`raw/sync/${hashBind}.json`)).toEqual(body);
  });
});
