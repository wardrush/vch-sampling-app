/**
 * A13 · v02 §11 criterion 3.
 *
 * *A duplicate barcode, a missing GPS fix, and a point outside its boundary
 * each produce **exactly one** defect row and reach the analyst queue within a
 * minute of sync.*
 *
 * "Exactly one" is the hard half. The nightly sweep can re-kick any batch, so a
 * rule that raised a row per run would satisfy this on a clean bench and fail
 * in the field. Both writers — the harness and the pipeline — key on
 * `MD5(subject|code)` for that reason, and the tests below check that the two
 * agree on the identifier rather than merely each being self-consistent.
 */

import { describe, expect, it } from 'vitest';
import { FakeSnowflake } from '../support/fake-snowflake.js';
import { defectId, runDefectRules } from '../../src/server/defects/harness.js';
import { duplicateBarcodeRule, noGpsFixRule } from '../../src/server/defects/rules/index.js';
import { runDerivationPipeline } from '../../src/server/derive/pipeline.js';
import { DEFECT_CODE } from '../../src/shared/codes/index.js';
import type { RuleContext } from '../../src/server/defects/types.js';

function context(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    sync_batch_id: 'batch-1',
    samples: [],
    bags: [],
    media: [],
    specs: new Map(),
    knownBarcodes: new Map(),
    ...overrides,
  };
}

describe('criterion 3 — one defect row each, and only one', () => {
  it('raises exactly one BARCODE_DUPLICATE for a barcode repeated in a batch', () => {
    const findings = duplicateBarcodeRule.run(
      context({
        bags: [
          { bag_id: 'bag-1', sample_uid: 's1', lab_id: 'AG', barcode_raw: 'LB-100', barcode_capture_method: 'scan', void_flag: false },
          { bag_id: 'bag-2', sample_uid: 's2', lab_id: 'AG', barcode_raw: 'LB-100', barcode_capture_method: 'scan', void_flag: false },
          { bag_id: 'bag-3', sample_uid: 's3', lab_id: 'AG', barcode_raw: 'LB-101', barcode_capture_method: 'scan', void_flag: false },
        ],
      }),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]!.defect_code).toBe(DEFECT_CODE.BARCODE_DUPLICATE);
    expect(findings[0]!.bag_id).toBe('bag-2');
  });

  it('raises BARCODE_DUPLICATE against a bag already in the warehouse', () => {
    const findings = duplicateBarcodeRule.run(
      context({
        bags: [
          { bag_id: 'bag-9', sample_uid: 's9', lab_id: 'AG', barcode_raw: 'LB-7', barcode_capture_method: 'scan', void_flag: false },
        ],
        knownBarcodes: new Map([['AG|LB-7', 'bag-old']]),
      }),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]!.detail).toContain('bag-old');
  });

  it('does not flag a voided bag — a voided label is not a duplicate', () => {
    const findings = duplicateBarcodeRule.run(
      context({
        bags: [
          { bag_id: 'bag-1', sample_uid: 's1', lab_id: 'AG', barcode_raw: 'LB-1', barcode_capture_method: 'scan', void_flag: true },
          { bag_id: 'bag-2', sample_uid: 's2', lab_id: 'AG', barcode_raw: 'LB-1', barcode_capture_method: 'scan', void_flag: false },
        ],
      }),
    );
    expect(findings).toHaveLength(0);
  });

  it('raises NO_GPS_FIX for a missing coordinate and for a dropped map pin', () => {
    const findings = noGpsFixRule.run(
      context({
        samples: [
          sample({ sample_uid: 'no-coord', lat: null, lon: null }),
          sample({ sample_uid: 'pinned', position_source: 'manual_map_pin' }),
          sample({ sample_uid: 'good' }),
        ],
      }),
    );

    expect(findings.map((f) => f.sample_uid)).toEqual(['no-coord', 'pinned']);
    expect(findings.every((f) => f.defect_code === DEFECT_CODE.NO_GPS_FIX)).toBe(true);
    expect(findings[1]!.detail).toContain('dropped map pin');
  });

  it('writes each finding under a deterministic id, so a re-run cannot duplicate', async () => {
    const sf = new FakeSnowflake();
    // Two samples, one bag, one spec lookup, one known-barcode lookup.
    sf.queueRows(
      ['SAMPLE_UID', 'VISIT_ID', 'PLAN_POINT_ID', 'BOUNDARY_ID', 'LAT', 'LON', 'GPS_ACCURACY_M',
       'FIX_COUNT', 'FIX_SPREAD_M', 'POSITION_SOURCE', 'OFFSET_FROM_PLAN_M',
       'DEVIATION_REASON_CODE', 'CAPTURED_TS_DEVICE', 'DEVICE_UPTIME_MS',
       'SERVER_RECEIVED_TS', 'DEPTH_ACHIEVED_CM', 'SPEC_ID'],
      [['s1', 'v1', null, 'b1', null, null, null, null, null, 'gps', null, null, null, null, null, null, null]],
    );
    sf.queueRows(['BAG_ID', 'SAMPLE_UID', 'LAB_ID', 'BARCODE_RAW', 'BARCODE_CAPTURE_METHOD', 'VOID_FLAG'], []);
    sf.queueRows(['MEDIA_ID', 'SAMPLE_UID', 'MEDIA_ROLE', 'IS_REQUIRED_ROLE', 'CAPTURE_SOURCE', 'EXIF_LAT', 'EXIF_LON', 'EXIF_TS'], []);

    const count = await runDefectRules('batch-1', { snowflake: sf.asClient() });
    expect(count).toBe(1);

    const merge = sf.matching('MERGE INTO CURATED.SAMPLE_DEFECT')[0];
    expect(merge).toBeDefined();
    const written = JSON.parse(String(merge!.binds[0])) as Array<{ defect_id: string }>;
    expect(written[0]!.defect_id).toBe(defectId('s1', DEFECT_CODE.NO_GPS_FIX));

    // MERGE on the defect id is what makes the second run a no-op.
    expect(merge!.sql).toContain('ON t.DEFECT_ID = s.DEFECT_ID');
  });

  it('raises POINT_OUTSIDE_BOUNDARY from the pipeline on the same id scheme', async () => {
    const sf = new FakeSnowflake();
    await runDerivationPipeline('batch-1', { snowflake: sf.asClient(), harness: { rules: [] } });

    // The code travels as a bind, not as SQL text — one statement shape
    // serves every code the pipeline raises.
    const merge = sf.statements.find(
      (s) =>
        s.sql.includes('MERGE INTO CURATED.SAMPLE_DEFECT') &&
        s.binds.includes(DEFECT_CODE.POINT_OUTSIDE_BOUNDARY),
    );
    expect(merge).toBeDefined();
    expect(merge!.sql).toContain('no active boundary contains this point');
    // Identical to the harness's `defectId`: MD5 over `subject|code`.
    expect(merge!.sql).toContain("MD5(q.SAMPLE_UID || '|' || ?)");
    expect(merge!.sql).toContain('ON t.DEFECT_ID = s.DEFECT_ID');
  });

  it('runs the pipeline steps in contract order', async () => {
    const sf = new FakeSnowflake();
    const result = await runDerivationPipeline('batch-1', {
      snowflake: sf.asClient(),
      harness: { rules: [] },
    });

    expect(result.steps).toEqual([
      'geography',
      'point_in_polygon',
      'trs',
      'offset_from_plan',
      'defect_rules',
      'review_state',
    ]);
  });

  it('never overwrites an analyst-accepted review state', async () => {
    const sf = new FakeSnowflake();
    await runDerivationPipeline('batch-1', { snowflake: sf.asClient(), harness: { rules: [] } });

    const reviewState = sf.matching('REVIEW_STATE = CASE')[0];
    expect(reviewState).toBeDefined();
    expect(reviewState!.sql).toContain("NOT IN ('accepted', 'rejected')");
  });
});

function sample(overrides: Record<string, unknown> = {}) {
  return {
    sample_uid: 's1',
    visit_id: 'v1',
    plan_point_id: null,
    boundary_id: 'b1',
    lat: 47.9,
    lon: -103.2,
    gps_accuracy_m: 4,
    fix_count: 5,
    fix_spread_m: 1.2,
    position_source: 'gps',
    offset_from_plan_m: 3,
    deviation_reason_code: null,
    captured_ts_device: '2026-10-02T15:00:00Z',
    device_uptime_ms: 1000,
    server_received_ts: '2026-10-02T23:00:00Z',
    depth_achieved_cm: null,
    spec_id: null,
    ...overrides,
  } as never;
}
