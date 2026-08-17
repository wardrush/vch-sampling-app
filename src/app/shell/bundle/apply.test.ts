/**
 * Proves the bundle apply+query round trip against real SQLite (same
 * pattern as `src/app/shell/db/device-db.test.ts`), not a hand-rolled fake —
 * `ON CONFLICT`/`DELETE`/foreign-key behaviour all matter here and a fake
 * would agree with whatever this test assumed.
 */
import { describe, expect, it } from 'vitest';
import { NodeSqliteDb } from '../../../../tests/support/node-sqlite.js';
import { bootstrapDeviceDb } from '@shared/db/schema.js';
import { applyBundleToDevice } from './apply.js';
import { demoBundleFromFixture } from './client.js';
import {
  getLatestBundleManifest,
  getPrimarySpec,
  getRefConditionCodes,
  getRefLabs,
  listBoundarySummaries,
  listPlanPoints,
  setPlanPointStatus,
} from './queries.js';

async function freshDb() {
  const db = new NodeSqliteDb(':memory:');
  await bootstrapDeviceDb(db);
  return db;
}

describe('applyBundleToDevice + queries', () => {
  it('writes every bundle table and the manifest', async () => {
    const db = await freshDb();
    const bundle = demoBundleFromFixture();

    await applyBundleToDevice(db, bundle);

    const manifest = await getLatestBundleManifest(db);
    expect(manifest?.bundle_id).toBe(bundle.bundle_id);
    expect(manifest?.boundary_count).toBe(1);
    expect(manifest?.plan_point_count).toBe(6);

    const summaries = await listBoundarySummaries(db);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.totalPoints).toBe(6);
    expect(summaries[0]?.sampledPoints).toBe(0);
    expect(summaries[0]?.property_name).toBe('Johnson Farm - East 40');

    const points = await listPlanPoints(db, 'b-001');
    expect(points).toHaveLength(6);
    expect(points.every((p) => p.local_status === 'pending')).toBe(true);

    const spec = await getPrimarySpec(db);
    expect(spec?.spec_id).toBe('spec-f26-bcarbon-v3');
    expect(spec?.required_media_roles).toEqual(['label_photo', 'core_photo', 'site_photo']);

    const labs = await getRefLabs(db);
    expect(labs).toHaveLength(1);

    const conditions = await getRefConditionCodes(db);
    expect(conditions.length).toBeGreaterThan(0);
    const band = conditions.find((c) => c.condition_code === 'RESIDUE_COVER_PCT');
    expect(band?.value_options).toContain('0-10%');
  });

  it('setPlanPointStatus is reflected in the next boundary summary read', async () => {
    const db = await freshDb();
    await applyBundleToDevice(db, demoBundleFromFixture());

    await setPlanPointStatus(db, 'pp-001', 'sampled');
    await setPlanPointStatus(db, 'pp-002', 'skipped');

    const [summary] = await listBoundarySummaries(db);
    expect(summary?.sampledPoints).toBe(1);
    expect(summary?.skippedPoints).toBe(1);
    expect(summary?.totalPoints).toBe(6);
  });

  it('is safe to apply twice (INSERT OR REPLACE on the manifest, replace-not-patch on the rest)', async () => {
    const db = await freshDb();
    const bundle = demoBundleFromFixture();
    await applyBundleToDevice(db, bundle);
    await applyBundleToDevice(db, bundle);

    const summaries = await listBoundarySummaries(db);
    expect(summaries).toHaveLength(1);
    const points = await listPlanPoints(db, 'b-001');
    expect(points).toHaveLength(6);
  });
});
