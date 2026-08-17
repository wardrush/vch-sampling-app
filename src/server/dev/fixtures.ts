/**
 * F0.8 -- reads the F0.7 fixture files off disk for mock-mode responses.
 * `netlify.toml`'s `included_files = ["fixtures/**"]` bundles them alongside
 * the function code, so this works identically in `netlify dev` and deployed
 * previews with `MOCK_SNOWFLAKE=1`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/server/dev -> repo root is three levels up.
const fixturesRoot = path.resolve(here, '../../../fixtures');

function readJson<T>(relPath: string): T {
  const full = path.join(fixturesRoot, relPath);
  return JSON.parse(readFileSync(full, 'utf8')) as T;
}

function readText(relPath: string): string {
  return readFileSync(path.join(fixturesRoot, relPath), 'utf8');
}

export interface BundleFixture {
  bundle_id: string;
  etag: string;
  schema_version: string;
  server_time: string;
  expires_ts: string;
  specs: unknown[];
  ref_condition_code: unknown[];
  ref_deviation_reason: unknown[];
  ref_defect_code: unknown[];
  ref_lab: unknown[];
  boundaries: Array<{
    boundary_id: string;
    geojson: GeoJSON.Polygon | GeoJSON.MultiPolygon;
    [key: string]: unknown;
  }>;
  plan_points: Array<{ plan_point_id: string; boundary_id: string; [key: string]: unknown }>;
  access_contacts: unknown[];
  tile_pack: unknown;
}

export function loadBundleFixture(): BundleFixture {
  return readJson<BundleFixture>('bundle.f26-demo.json');
}

export function loadDefectFeedFixture(): unknown {
  return readJson('defect_feed.json');
}

export function loadSyncBatchExampleFixture(): unknown {
  return readJson('sync_batch/example.json');
}

export function loadPlanImport12RowFixture(): string {
  return readText('plan_import_12row.tsv');
}
