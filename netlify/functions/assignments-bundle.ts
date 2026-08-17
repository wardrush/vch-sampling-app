/**
 * A2 — `GET /v1/assignments/bundle?crew_org_id=…&period=…`. Logic lives in
 * `src/server/assignments/bundle.ts`; this wrapper resolves mock vs live and
 * honours `If-None-Match` (contract §2: a match returns 304, no body).
 */
import { assembleLiveBundle } from '../../src/server/assignments/bundle.js';
import { isMockMode } from '../../src/server/dev/mock-mode.js';
import { loadBundleFixture } from '../../src/server/dev/fixtures.js';
import { sqlClient } from '../../src/server/env.js';
import type { AssignmentBundle } from '../../src/shared/contract/bundle.js';

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);

  const url = new URL(request.url);
  const crewOrgId = url.searchParams.get('crew_org_id');
  const period = url.searchParams.get('period');
  if (!crewOrgId || !period) {
    return json({ error: 'crew_org_id and period are required' }, 400);
  }
  const ifNoneMatch = request.headers.get('if-none-match');

  const bundle = isMockMode() ? mockBundle() : await assembleLiveBundle({ crewOrgId, period }, { snowflake: sqlClient() });

  if (ifNoneMatch && ifNoneMatch === bundle.etag) {
    return new Response(null, { status: 304, headers: { etag: bundle.etag, 'cache-control': 'no-cache' } });
  }

  return json(bundle, 200, { etag: bundle.etag });
}

function mockBundle(): AssignmentBundle {
  // The F0.7 fixture is close to the wire shape but was authored before F0.4
  // landed (see fixtures/bundle.f26-demo.json's own field names); reshape
  // rather than trust it byte-for-byte, so a fixture edit can't silently
  // drift the contract this endpoint actually returns.
  const fixture = loadBundleFixture();
  return {
    bundle_id: fixture.bundle_id,
    etag: fixture.etag,
    schema_version: fixture.schema_version,
    server_time: new Date().toISOString(),
    expires_ts: fixture.expires_ts,
    specs: fixture.specs as AssignmentBundle['specs'],
    ref_condition_code: fixture.ref_condition_code as AssignmentBundle['ref_condition_code'],
    ref_deviation_reason: fixture.ref_deviation_reason as AssignmentBundle['ref_deviation_reason'],
    ref_defect_code: fixture.ref_defect_code as AssignmentBundle['ref_defect_code'],
    ref_lab: fixture.ref_lab as AssignmentBundle['ref_lab'],
    boundaries: fixture.boundaries.map((b) => ({
      boundary_id: b.boundary_id,
      property_id: null,
      property_name: (b as Record<string, unknown>).boundary_name as string | null ?? null,
      operation_name: null,
      geojson: b.geojson,
      bbox: null,
      centroid_lat: null,
      centroid_lon: null,
      geom_acres: ((b as Record<string, unknown>).geom_acres as number) ?? null,
      trs_canonical: null,
      access_note: null,
      plan_id: null,
      spec_id: null,
      period_code: null,
      sort_order: null,
    })),
    plan_points: fixture.plan_points as unknown as AssignmentBundle['plan_points'],
    access_contacts: fixture.access_contacts as unknown as AssignmentBundle['access_contacts'],
    tile_pack: fixture.tile_pack as unknown as AssignmentBundle['tile_pack'],
  };
}

function json(body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}
