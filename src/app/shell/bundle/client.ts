/**
 * B4/B5 — down-sync client for the assignment bundle (contract §2,
 * `src/shared/contract/bundle.ts`).
 *
 * **Two paths, tried in order, every call — nothing here special-cases "dev":**
 *
 *  1. `GET /v1/assignments/bundle`, the real contract. `netlify.toml` routes
 *     it to `assignments-bundle.ts`, which resolves `MOCK_SNOWFLAKE=1` (or no
 *     `SNOWFLAKE_ACCOUNT`) through the F0.7 fixture server-side. This works
 *     under `netlify dev` and a deployed preview.
 *  2. A **local fallback**, the same fixture imported directly and reshaped
 *     the same way `netlify/functions/assignments-bundle.ts`'s own
 *     `mockBundle()` does. This is what actually answers under plain
 *     `npm run dev` (`vite`, no functions runtime behind it — there is
 *     nowhere for path 1 to land), which is this lane's definition-of-done
 *     demo path. Documented as a real gap, not a design choice: there is no
 *     dev-time proxy from Vite to the Netlify functions runtime in this
 *     repo, and `vite.config.ts` is orchestrator-owned so it isn't this
 *     agent's file to add one to. See the wave-2 report.
 *
 * The reshape in path 2 is intentionally a second, independent copy of the
 * one in `netlify/functions/assignments-bundle.ts`'s `mockBundle()` rather
 * than an import of it — that file lives under `netlify/functions/**`, which
 * this agent does not own, and it reads the fixture with `node:fs`, which
 * does not exist in a browser bundle.
 */

import { uuidv7 } from 'uuidv7';
import type {
  AccessContact,
  AssignedBoundary,
  AssignmentBundle,
  BundlePlanPoint,
} from '../../../shared/contract/bundle.js';
import demoFixture from '@fixtures/bundle.f26-demo.json';

const DEMO_CREW_ORG_ID = 'demo-crew';
const DEMO_PERIOD = 'F26';

export interface FetchBundleOptions {
  crewOrgId?: string;
  period?: string;
}

export interface FetchBundleResult {
  bundle: AssignmentBundle;
  /** Which path answered — surfaced so the Today screen can be honest about it. */
  source: 'network' | 'local_fixture';
}

export async function fetchAssignmentBundle(
  opts: FetchBundleOptions = {},
): Promise<FetchBundleResult> {
  const crewOrgId = opts.crewOrgId ?? DEMO_CREW_ORG_ID;
  const period = opts.period ?? DEMO_PERIOD;

  try {
    const url = `/v1/assignments/bundle?crew_org_id=${encodeURIComponent(crewOrgId)}&period=${encodeURIComponent(period)}`;
    const res = await fetch(url);
    if (res.ok) {
      const bundle = (await res.json()) as AssignmentBundle;
      return { bundle, source: 'network' };
    }
    // Any non-2xx (404 under plain `vite dev`, 500 mid-deploy, etc.) falls
    // through to the local fixture rather than stranding the screen.
  } catch {
    // Network error, `fetch` unavailable, or no functions runtime listening —
    // all the same outcome: fall back below.
  }

  return { bundle: demoBundleFromFixture(), source: 'local_fixture' };
}

/**
 * The F0.7 fixture, reshaped to the wire contract. See module header.
 *
 * Every field is set explicitly, never a blind `as` cast of a whole array —
 * the fixture omits several nullable columns entirely (JSON has no
 * `undefined`, so an absent key is just absent) and a device SQLite bind
 * rejects `undefined` where the wire contract's `null` is fine. Reshaping
 * field-by-field, the same discipline `netlify/functions/assignments-bundle.ts`'s
 * own `mockBundle()` already applies to `boundaries`, is what makes this a
 * fixture-format problem caught here rather than a bind-time crash three
 * modules away in `apply.ts`.
 */
export function demoBundleFromFixture(): AssignmentBundle {
  const f = demoFixture as unknown as RawFixture;
  const boundaries: AssignedBoundary[] = f.boundaries.map((b) => ({
    boundary_id: b.boundary_id,
    property_id: null,
    property_name: b.boundary_name ?? null,
    operation_name: null,
    geojson: b.geojson,
    bbox: null,
    centroid_lat: null,
    centroid_lon: null,
    geom_acres: b.geom_acres ?? null,
    trs_canonical: null,
    access_note: null,
    plan_id: null,
    spec_id: null,
    period_code: null,
    sort_order: null,
  }));

  // The fixture carries one boundary and does not repeat `boundary_id` on
  // each plan point (unlike the real wire contract, which requires it) —
  // defaulting to "the boundary this demo bundle has" is correct for this
  // fixture and would need revisiting the day a second-boundary fixture
  // exists.
  const defaultBoundaryId = boundaries[0]?.boundary_id ?? '';
  const planPoints: BundlePlanPoint[] = f.plan_points.map((p) => ({
    plan_point_id: p.plan_point_id,
    plan_id: null,
    boundary_id: p.boundary_id ?? defaultBoundaryId,
    plan_point_label: p.plan_point_label ?? null,
    planned_lat: p.planned_lat,
    planned_lon: p.planned_lon,
    strata_label: p.strata_label ?? null,
    elevation_class: p.elevation_class ?? null,
    prior_sample_uid: null,
    prior_lat: null,
    prior_lon: null,
    sequence_no: p.sequence_no ?? null,
    access_note: null,
  }));

  const accessContacts: AccessContact[] = f.access_contacts.map((c) => ({
    contact_id: c.contact_id ?? uuidv7(),
    boundary_id: c.boundary_id,
    person_id: null,
    display_name: c.display_name ?? null,
    role_label: c.role_label ?? null,
    phone: c.phone ?? null,
    is_primary: c.is_primary ?? true,
  }));

  return {
    bundle_id: f.bundle_id,
    etag: f.etag,
    schema_version: f.schema_version,
    // Fresh every call, same reasoning as A2's own assembleBundle(): this is
    // the clock-drift baseline, not part of the etag's stable content.
    server_time: new Date().toISOString(),
    expires_ts: f.expires_ts,
    specs: f.specs as AssignmentBundle['specs'],
    ref_condition_code: f.ref_condition_code as AssignmentBundle['ref_condition_code'],
    ref_deviation_reason: f.ref_deviation_reason as AssignmentBundle['ref_deviation_reason'],
    ref_defect_code: f.ref_defect_code as AssignmentBundle['ref_defect_code'],
    ref_lab: f.ref_lab as AssignmentBundle['ref_lab'],
    boundaries,
    plan_points: planPoints,
    access_contacts: accessContacts,
    tile_pack: f.tile_pack as unknown as AssignmentBundle['tile_pack'],
  };
}

/** The fixture's own shape — a superset of the wire contract in a few spots
 *  (`boundary_name` where the wire has `property_name`) and missing a few
 *  nullable wire columns entirely, see module header. */
interface RawFixture {
  bundle_id: string;
  etag: string;
  schema_version: string;
  expires_ts: string;
  specs: unknown[];
  ref_condition_code: unknown[];
  ref_deviation_reason: unknown[];
  ref_defect_code: unknown[];
  ref_lab: unknown[];
  boundaries: Array<{
    boundary_id: string;
    boundary_name?: string | null;
    geom_acres?: number | null;
    geojson: AssignedBoundary['geojson'];
  }>;
  plan_points: Array<{
    plan_point_id: string;
    boundary_id?: string;
    plan_point_label?: string | null;
    planned_lat: number;
    planned_lon: number;
    strata_label?: string | null;
    elevation_class?: string | null;
    sequence_no?: number | null;
  }>;
  access_contacts: Array<{
    contact_id?: string;
    boundary_id: string;
    display_name?: string | null;
    role_label?: string | null;
    phone?: string | null;
    is_primary?: boolean;
  }>;
  tile_pack: unknown;
}
