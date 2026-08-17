/**
 * C7 — `POST /ingest/validate`. Addendum §4.3, ingest spec §5.
 *
 * Stateless, idempotent, no writes — point-in-polygon against active
 * boundaries, duplicate checks (in-file duplicates are C6's job, client-side;
 * this checks against a *released* plan), operation/contact fuzzy matching
 * (C8), and an implausible-distance sanity check that catches the wrong-file
 * upload before it becomes a crew's day.
 *
 * A 5,000-row file stays inside Netlify's 60 s synchronous ceiling because
 * every check here is either a single batched query or a pure function — the
 * per-row cost is O(boundaries) for PIP, not O(rows × boundaries × network).
 */
import type {
  IngestValidateRequest,
  IngestValidateResponse,
  ParsedPlanRow,
  ValidatedPlanRow,
} from '../../shared/contract/ingest.js';
import type { SnowflakeClient } from '../../shared/snowflake/client.js';
import { asObjects } from '../../shared/snowflake/client.js';
import { pointInPolygon } from '../../shared/geo/point-in-polygon.js';
import { haversineMetres } from '../../shared/geo/distance.js';
import {
  scoreCandidates,
  findOperationCandidates,
  findContactCandidates,
  DEFAULT_MATCH_CONFIG,
  type MatchConfig,
} from './match.js';

export interface ValidateBoundary {
  boundary_id: string;
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  centroid_lat: number;
  centroid_lon: number;
}

export interface ValidateDeps {
  /** Active boundaries to test rows against. Real mode: from `V_BOUNDARY_ENTITY`. */
  boundaries: ValidateBoundary[];
  /** `plan_point_label`s already released for this boundary + period. */
  existingLabelsByBoundary: Map<string, Set<string>>;
  findOperationCandidates: (text: string) => Promise<{ id: string; label: string }[]>;
  findContactCandidates: (text: string) => Promise<{ id: string; label: string }[]>;
  matchConfig?: MatchConfig;
  /** Rows further than this from every assigned boundary are IMPLAUSIBLE_DISTANCE. */
  implausibleDistanceM?: number;
  now?: () => number;
}

const DEFAULT_IMPLAUSIBLE_DISTANCE_M = 5_000;

export async function validateRows(
  request: IngestValidateRequest,
  deps: ValidateDeps,
): Promise<IngestValidateResponse> {
  const now = deps.now ?? Date.now;
  const config = deps.matchConfig ?? DEFAULT_MATCH_CONFIG;
  const implausibleM = deps.implausibleDistanceM ?? DEFAULT_IMPLAUSIBLE_DISTANCE_M;

  const seenInThisRequest = new Map<string, number>();
  const rows: ValidatedPlanRow[] = [];

  for (const row of request.rows) {
    rows.push(await validateOne(row, deps, config, implausibleM, seenInThisRequest));
  }

  const summary = {
    row_count: rows.length,
    rows_ready: rows.filter((r) => r.row_status === 'ready').length,
    rows_flagged: rows.filter((r) => r.row_status === 'flagged').length,
    rows_blocked: rows.filter((r) => r.row_status === 'blocked').length,
  };

  return { server_time: new Date(now()).toISOString(), rows, summary };
}

async function validateOne(
  row: ParsedPlanRow,
  deps: ValidateDeps,
  config: MatchConfig,
  implausibleM: number,
  seenInThisRequest: Map<string, number>,
): Promise<ValidatedPlanRow> {
  const codes: string[] = [];

  if (!row.plan_point_label || row.lat === null || row.lon === null) {
    codes.push('MISSING_REQUIRED_FIELD');
    return blocked(row, codes);
  }

  // Duplicate against an existing RELEASED plan for the stated boundary + period.
  const statedBoundary = row.boundary_id_stated;
  if (statedBoundary) {
    const existing = deps.existingLabelsByBoundary.get(statedBoundary);
    if (existing?.has(row.plan_point_label)) {
      codes.push('DUPLICATE_LABEL_AGAINST_PLAN');
    }
  }
  const priorRow = seenInThisRequest.get(row.plan_point_label);
  if (priorRow !== undefined) codes.push('DUPLICATE_LABEL_IN_FILE');
  seenInThisRequest.set(row.plan_point_label, row.source_row_no);
  if (codes.includes('DUPLICATE_LABEL_AGAINST_PLAN') || codes.includes('DUPLICATE_LABEL_IN_FILE')) {
    return blocked(row, codes);
  }

  // Point-in-polygon against every active boundary (contract §6 step 4's
  // logic, run here so the analyst sees POINT_OUTSIDE_BOUNDARY before commit
  // rather than after — same code, same meaning, spec §5).
  const point = { lat: row.lat, lon: row.lon };
  let resolvedBoundary: string | null = null;
  for (const b of deps.boundaries) {
    if (pointInPolygon(point, b.geometry)) {
      resolvedBoundary = b.boundary_id;
      break;
    }
  }
  if (!resolvedBoundary) {
    codes.push('POINT_OUTSIDE_BOUNDARY');
  } else if (statedBoundary && resolvedBoundary !== statedBoundary) {
    codes.push('BOUNDARY_MISMATCH');
  }

  // Implausible distance -- catches the wrong-file upload. Nearest assigned
  // boundary centroid; if nothing is within range, this is likely not this
  // period's ground at all.
  if (deps.boundaries.length > 0) {
    const nearest = Math.min(
      ...deps.boundaries.map((b) =>
        haversineMetres(point, { lat: b.centroid_lat, lon: b.centroid_lon }),
      ),
    );
    if (nearest > implausibleM) codes.push('IMPLAUSIBLE_DISTANCE');
  }

  // Operation / contact fuzzy matching -- suggest, never create (D16).
  let operationMatch: Awaited<ReturnType<typeof scoreCandidates>> = { status: null as never, candidates: [] };
  if (row.operation_text) {
    const pool = await deps.findOperationCandidates(row.operation_text);
    const scored = scoreCandidates(row.operation_text, pool, config);
    operationMatch = scored;
    if (scored.status === 'unmatched') codes.push('OPERATION_UNMATCHED');
    else if (scored.status === 'suggested') codes.push('OPERATION_LOW_CONFIDENCE_MATCH');
  }

  let contactMatch: Awaited<ReturnType<typeof scoreCandidates>> = { status: null as never, candidates: [] };
  if (row.contact_name_text) {
    const pool = await deps.findContactCandidates(row.contact_name_text);
    const scored = scoreCandidates(row.contact_name_text, pool, config);
    contactMatch = scored;
    if (scored.status === 'unmatched') codes.push('CONTACT_UNMATCHED');
  }

  if (Object.keys(row.extra).length > 0) codes.push('UNMAPPED_COLUMNS_PRESENT');
  if (row.elevation_class && !['A', 'B'].includes(row.elevation_class)) {
    codes.push('ELEVATION_CLASS_UNKNOWN_VALUE');
  }
  if (!row.strata_label) codes.push('NO_STRATA_LABEL');

  const blockingCodes = new Set(['MISSING_REQUIRED_FIELD', 'COORD_UNPARSEABLE', 'COORD_OUT_OF_RANGE']);
  const reviewCodes = new Set([
    'POINT_OUTSIDE_BOUNDARY',
    'BOUNDARY_MISMATCH',
    'OPERATION_LOW_CONFIDENCE_MATCH',
    'OPERATION_UNMATCHED',
    'CONTACT_UNMATCHED',
    'IMPLAUSIBLE_DISTANCE',
  ]);
  const status = codes.some((c) => blockingCodes.has(c))
    ? 'blocked'
    : codes.some((c) => reviewCodes.has(c))
      ? 'flagged'
      : 'ready';

  return {
    source_row_no: row.source_row_no,
    boundary_id_resolved: resolvedBoundary,
    operation_match_id: operationMatch.candidates[0]?.id ?? null,
    operation_match_score: operationMatch.candidates[0]?.score ?? null,
    operation_match_status: row.operation_text ? operationMatch.status : null,
    operation_candidates: operationMatch.candidates,
    contact_match_id: contactMatch.candidates[0]?.id ?? null,
    contact_match_score: contactMatch.candidates[0]?.score ?? null,
    contact_match_status: row.contact_name_text ? contactMatch.status : null,
    contact_candidates: contactMatch.candidates,
    row_status: status,
    validation_codes: codes,
  };
}

function blocked(row: ParsedPlanRow, codes: string[]): ValidatedPlanRow {
  return {
    source_row_no: row.source_row_no,
    boundary_id_resolved: null,
    operation_match_id: null,
    operation_match_score: null,
    operation_match_status: null,
    operation_candidates: [],
    contact_match_id: null,
    contact_match_score: null,
    contact_match_status: null,
    contact_candidates: [],
    row_status: 'blocked',
    validation_codes: codes,
  };
}

/** Real-mode dependency wiring against live Snowflake. */
export function liveDeps(
  sf: SnowflakeClient,
  boundaries: ValidateBoundary[],
  existingLabelsByBoundary: Map<string, Set<string>>,
  matchConfig?: MatchConfig,
): ValidateDeps {
  return {
    boundaries,
    existingLabelsByBoundary,
    findOperationCandidates: (text) => findOperationCandidates(sf, text),
    findContactCandidates: (text) => findContactCandidates(sf, text),
    matchConfig,
  };
}

export async function loadExistingLabels(
  sf: SnowflakeClient,
  periodCode: string,
  boundaryIds: readonly string[],
): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>();
  if (boundaryIds.length === 0) return map;
  const rows = asObjects<{ boundary_id: string; plan_point_label: string }>(
    await sf.execute(
      `SELECT pp.PLAN_POINT_LABEL, p.BOUNDARY_ID
         FROM CURATED.SAMPLE_PLAN_POINT pp
         JOIN CURATED.SAMPLE_PLAN p ON p.PLAN_ID = pp.PLAN_ID
        WHERE p.PERIOD_CODE = ? AND p.STATUS = 'released'
          AND p.BOUNDARY_ID IN (${boundaryIds.map(() => '?').join(',')})`,
      { binds: [periodCode, ...boundaryIds] },
    ),
  );
  for (const row of rows) {
    if (!row.plan_point_label) continue;
    const set = map.get(row.boundary_id) ?? new Set<string>();
    set.add(row.plan_point_label);
    map.set(row.boundary_id, set);
  }
  return map;
}
