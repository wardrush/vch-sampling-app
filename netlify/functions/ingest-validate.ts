/**
 * C7 — `POST /ingest/validate`. See `src/ingest/validate/index.ts` for the
 * logic; this wrapper only resolves dependencies (live Snowflake, or the F0.7
 * fixture boundary set under `MOCK_SNOWFLAKE=1` / no `SNOWFLAKE_ACCOUNT`) and
 * the session.
 */
import type { IngestValidateRequest } from '../../src/shared/contract/ingest.js';
import { validateRows, liveDeps, loadExistingLabels, type ValidateBoundary } from '../../src/ingest/validate/index.js';
import { findOperationCandidates as findOperationCandidatesLive, findContactCandidates as findContactCandidatesLive } from '../../src/ingest/validate/match.js';
import { requireSession } from '../../src/shared/auth/session.js';
import { sessionSecret, snowflake } from '../../src/server/env.js';
import { asObjects } from '../../src/shared/snowflake/client.js';
import { isMockMode } from '../../src/server/dev/mock-mode.js';
import { loadBundleFixture } from '../../src/server/dev/fixtures.js';
import { bboxOf } from '../../src/shared/geo/point-in-polygon.js';

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  if (!isMockMode()) {
    const session = requireSession(request, sessionSecret());
    if (!session) return json({ error: 'no session' }, 401);
    if (session.surface !== 'ingest') return json({ error: 'wrong surface' }, 403);
  }

  let body: IngestValidateRequest;
  try {
    body = (await request.json()) as IngestValidateRequest;
  } catch {
    return json({ error: 'body is not valid JSON' }, 400);
  }
  if (!Array.isArray(body.rows)) return json({ error: 'rows is required' }, 400);

  const deps = isMockMode() ? mockDeps() : await liveDepsFor(body);
  const result = await validateRows(body, deps);
  return json(result, 200);
}

function mockDeps() {
  const bundle = loadBundleFixture();
  const boundaries: ValidateBoundary[] = bundle.boundaries.map((b) => {
    const [west, south, east, north] = bboxOf(b.geojson);
    return {
      boundary_id: b.boundary_id,
      geometry: b.geojson,
      centroid_lat: (south + north) / 2,
      centroid_lon: (west + east) / 2,
    };
  });
  // Mock candidate pool for operation/contact fuzzy matching -- representative
  // of the tutorial's fault set (spec §8 row 7: "Bring Farms" vs "Ben Bring
  // Farms LLC"), not a stand-in for live CRM data.
  const operationPool = [
    { id: 'op-001', label: 'Ben Bring Farms LLC' },
    { id: 'op-002', label: 'Johnson Farm LLC' },
    { id: 'op-003', label: 'Mitchell Farms' },
    { id: 'op-004', label: 'Edwards Estate' },
  ];
  const contactPool = [
    { id: 'ct-001', label: 'John Johnson' },
    { id: 'ct-002', label: 'Sarah Mitchell' },
    { id: 'ct-003', label: 'Bob Bring' },
    { id: 'ct-004', label: 'Ed Edwards' },
  ];
  return {
    boundaries,
    existingLabelsByBoundary: new Map<string, Set<string>>(),
    findOperationCandidates: async (text: string) => operationPool,
    findContactCandidates: async (text: string) => contactPool,
  };
}

async function liveDepsFor(body: IngestValidateRequest) {
  const sf = snowflake();
  const boundaryRows = asObjects<{
    boundary_id: string;
    geog: string | null;
    centroid_lat: string | null;
    centroid_lon: string | null;
  }>(
    await sf.execute(
      `SELECT BOUNDARY_ID, ST_ASGEOJSON(GEOG) AS GEOG,
              ST_Y(ST_CENTROID(GEOG)) AS CENTROID_LAT, ST_X(ST_CENTROID(GEOG)) AS CENTROID_LON
         FROM CURATED.V_BOUNDARY_ENTITY WHERE STATUS = 'active'`,
    ),
  );
  const boundaries: ValidateBoundary[] = boundaryRows
    .filter((r) => r.geog)
    .map((r) => ({
      boundary_id: r.boundary_id,
      geometry: JSON.parse(r.geog!) as GeoJSON.Polygon | GeoJSON.MultiPolygon,
      centroid_lat: Number(r.centroid_lat ?? 0),
      centroid_lon: Number(r.centroid_lon ?? 0),
    }));

  const existingLabelsByBoundary = await loadExistingLabels(
    sf,
    body.period_code,
    boundaries.map((b) => b.boundary_id),
  );

  return {
    ...liveDeps(sf, boundaries, existingLabelsByBoundary),
    findOperationCandidates: (text: string) => findOperationCandidatesLive(sf, text),
    findContactCandidates: (text: string) => findContactCandidatesLive(sf, text),
  };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
