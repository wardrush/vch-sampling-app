/**
 * `assembleLiveBundle` on the SQL port. Wave 2 follow-up: `assignments-bundle`
 * used to be typed against `SnowflakeClient` all the way down, so it threw
 * `missing required environment variable SNOWFLAKE_ACCOUNT` the moment
 * `isMockMode()` was fixed to key off the selected backend and the Postgres
 * path became reachable. This file proves the live branch now runs on both
 * dialects, using the same recording fake (`FakeSqlClient`,
 * `tests/acceptance/support/fake-sql-client.ts`) `sync-spine` already built
 * for the identical problem in `src/server/{sync,derive}/**`, rather than
 * inventing a third fake.
 *
 * `tests/unit/sonnet-additions.test.ts` already covers `assembleBundle` (the
 * pure etag/expiry logic); this file is `assembleLiveBundle` (the query
 * layer) and does not duplicate that coverage.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FakeSqlClient, BOTH_DIALECTS } from '../acceptance/support/fake-sql-client.js';
import { assembleLiveBundle } from '../../src/server/assignments/bundle.js';
import type { SqlDialect } from '../../src/shared/db/port.js';

const GEOJSON = {
  type: 'Polygon' as const,
  coordinates: [
    [
      [-99.13, 47.54],
      [-99.115, 47.54],
      [-99.115, 47.555],
      [-99.13, 47.555],
      [-99.13, 47.54],
    ],
  ],
};

/**
 * Queues the nine statements `assembleLiveBundle` issues, in the order it
 * issues them: `boundaryIdsForCrew`, then the six reference/spec SELECTs
 * (only `specs` populated here), then `loadBoundaries`, `loadPlanPoints`,
 * `loadAccessContacts`. The `await` inside each `Promise.all` array element
 * makes this sequential in practice (each element's `execute()` resolves
 * before the next one is even called), which is what makes queue order safe
 * to rely on in this test.
 */
function primeClient(client: FakeSqlClient): void {
  client.queueRows(['boundary_id'], [['b-1']]);
  client.queueRows(
    [
      'spec_id', 'project_id', 'protocol_version', 'period_code', 'depth_top_cm',
      'depth_bottom_cm', 'depth_increments_json', 'overdrill_cm', 'cores_per_composite_min',
      'cores_per_composite_max', 'composite_radius_m', 'bd_core_required', 'bag_scheme',
      'required_media_roles', 'gps_accuracy_required_m', 'min_gps_fix_count',
      'max_plan_offset_m_warn', 'max_plan_offset_m_block', 'default_lab_id',
    ],
    [[
      'spec-1', 'proj-1', 'BCARBON_V3.0', 'F26', '0', '30', '[[0,15],[15,30]]', '5',
      '5', '10', '2', 'true', 'ONE_BAG_PER_POINT', '["label_photo"]', '10', '3',
      '15', '30', 'lab-1',
    ]],
  );
  client.queueRows(['condition_code', 'code_set_version', 'condition_group', 'display_label', 'value_type', 'value_options', 'sort_order'], []);
  client.queueRows(['deviation_reason_code', 'display_label', 'requires_note', 'requires_photo', 'is_skip_reason'], []);
  client.queueRows(['defect_code', 'display_label', 'default_severity', 'raised_by'], []);
  client.queueRows(['lab_id', 'lab_name', 'barcode_symbology', 'barcode_pattern'], []);
  client.queueRows(
    [
      'boundary_id', 'property_id', 'property_name', 'operation_name', 'geojson_raw',
      'west', 'south', 'east', 'north', 'centroid_lat', 'centroid_lon', 'geom_acres',
      'trs_canonical', 'access_note', 'plan_id', 'spec_id', 'period_code', 'sort_order',
    ],
    [[
      'b-1', null, 'Test Farm', null, JSON.stringify(GEOJSON),
      '-99.13', '47.54', '-99.115', '47.555', '47.5475', '-99.1225', '160.5',
      null, null, 'plan-1', 'spec-1', 'F26', null,
    ]],
  );
  client.queueRows(
    [
      'plan_point_id', 'plan_id', 'boundary_id', 'plan_point_label', 'planned_lat',
      'planned_lon', 'strata_label', 'elevation_class', 'prior_sample_uid',
      'prior_lat', 'prior_lon', 'sequence_no', 'access_note',
    ],
    [['pp-1', 'plan-1', 'b-1', '1', '47.5475', '-99.1225', null, null, null, null, null, '1', null]],
  );
  client.queueRows(['contact_id', 'boundary_id', 'person_id', 'display_name', 'role_label', 'phone', 'is_primary'], []);
}

describe.each(BOTH_DIALECTS)('assembleLiveBundle on %s', (dialect: SqlDialect) => {
  let client: FakeSqlClient;

  beforeEach(() => {
    client = new FakeSqlClient(dialect);
    primeClient(client);
  });

  it('returns a bundle instead of throwing', async () => {
    const bundle = await assembleLiveBundle(
      { crewOrgId: 'crew_vch_north', period: 'F26' },
      { snowflake: client.asSqlClient() },
    );
    expect(bundle.bundle_id).toBeTruthy();
    expect(bundle.etag).toMatch(/^sha256:/);
    expect(bundle.specs).toHaveLength(1);
    expect(bundle.boundaries).toHaveLength(1);
    expect(bundle.plan_points).toHaveLength(1);
    expect(bundle.access_contacts).toEqual([]);
    expect(bundle.tile_pack).toBeNull();
  });

  it('decodes the boundary geojson identically regardless of backend', async () => {
    const bundle = await assembleLiveBundle(
      { crewOrgId: 'crew_vch_north', period: 'F26' },
      { snowflake: client.asSqlClient() },
    );
    expect(bundle.boundaries[0]!.geojson).toEqual(GEOJSON);
    expect(bundle.boundaries[0]!.bbox).toEqual([-99.13, 47.54, -99.115, 47.555]);
    expect(bundle.boundaries[0]!.centroid_lat).toBeCloseTo(47.5475);
    expect(bundle.boundaries[0]!.centroid_lon).toBeCloseTo(-99.1225);
    expect(bundle.boundaries[0]!.geom_acres).toBeCloseTo(160.5);
  });

  it('never emits Snowflake-only syntax on Postgres, and vice versa', async () => {
    await assembleLiveBundle(
      { crewOrgId: 'crew_vch_north', period: 'F26' },
      { snowflake: client.asSqlClient() },
    );
    const allSql = client.statements.map((s) => s.sql).join('\n');
    if (dialect === 'postgres') {
      expect(allSql).not.toMatch(/ST_ASGEOJSON|ST_XMIN|ST_CENTROID|CURRENT_DATE\(\)/);
      expect(allSql).toContain('CURRENT_DATE');
      expect(allSql).toMatch(/b\.GEOJSON AS geojson_raw/);
    } else {
      expect(allSql).toMatch(/ST_ASGEOJSON/);
      expect(allSql).toContain('CURRENT_DATE()');
    }
  });
});

describe('loadAccessContacts failure visibility', () => {
  it('still returns [] on a query failure, but logs it rather than swallowing silently', async () => {
    const client = new FakeSqlClient('postgres');
    primeClient(client);
    // Replace the queued empty access-contacts result with a thrown error.
    client.failWhen('CURATED.ACCESS_CONTACT', new Error('relation "curated.access_contact" does not exist'));

    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      const bundle = await assembleLiveBundle(
        { crewOrgId: 'crew_vch_north', period: 'F26' },
        { snowflake: client.asSqlClient() },
      );
      expect(bundle.access_contacts).toEqual([]);
    } finally {
      console.error = originalError;
    }
    expect(errors.length).toBeGreaterThan(0);
    expect(String(errors[0]![0])).toMatch(/loadAccessContacts/);
  });
});
