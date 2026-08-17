/**
 * A13 · v02 §11 criterion 5.
 *
 * *`CURATED` is dropped and rebuilt entirely from `RAW`, byte-identical.*
 *
 * The full criterion needs a warehouse. What can be established without one —
 * and what actually decides whether the criterion holds a year from now — is
 * that **there is only one parse**. Two code paths that agree today diverge the
 * first time someone adds a column to the live path and forgets the rebuild
 * path, and the divergence is invisible until someone tries the rebuild.
 *
 * So the test asserts the structural property: the live path and the rebuild
 * path produce the same projection, differing only in where the rows come from.
 */

import { describe, expect, it } from 'vitest';
import { curatedMergeSql, mergeableEntityTypes } from '../../src/server/sync/merge.js';

/** Everything between `USING (` and `FROM TABLE(FLATTEN` — the parse itself. */
function projection(sql: string): string {
  const start = sql.indexOf('USING (');
  const end = sql.indexOf('FROM TABLE(FLATTEN');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe('criterion 5 — CURATED is rebuildable from RAW', () => {
  it('uses one parse for the live path and the rebuild path', () => {
    for (const entityType of mergeableEntityTypes()) {
      const live = curatedMergeSql(entityType, 'PARSE_JSON(?)', '?');
      const rebuild = curatedMergeSql(
        entityType,
        `(SELECT ARRAY_AGG(rec.value:payload) FROM RAW.SYNC_PAYLOAD p,
            TABLE(FLATTEN(input => p.PAYLOAD:records)) rec
           WHERE rec.value:entity_type::VARCHAR = '${entityType}')`,
        '?',
      );

      // Same columns, same casts, same order. Only the source differs.
      expect(projection(rebuild)).toBe(projection(live));
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
      'BARCODE_NORM',
    ];
    const sql = curatedMergeSql('sample_point', 'PARSE_JSON(?)', '?');
    const insertClause = sql.slice(sql.indexOf('INSERT ('), sql.indexOf('VALUES ('));

    for (const column of derived) {
      expect(insertClause).not.toContain(`${column},`);
      expect(insertClause).not.toContain(`${column})`);
    }
  });

  it('refuses to overwrite a sample an analyst has accepted', () => {
    const sql = curatedMergeSql('sample_point', 'PARSE_JSON(?)', '?');
    expect(sql).toContain("COALESCE(t.REVIEW_STATE, 'captured') <> 'accepted'");
  });

  it('stamps every merged row with its sync batch', () => {
    for (const entityType of mergeableEntityTypes()) {
      const sql = curatedMergeSql(entityType, 'PARSE_JSON(?)', '?');
      expect(sql).toContain('SYNC_BATCH_ID');
    }
  });
});
