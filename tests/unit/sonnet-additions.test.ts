/**
 * Smoke coverage for the Sonnet-tagged F0.8/A2/C7/C8/C12 additions: the pure
 * logic (fuzzy match scoring, point-in-polygon, bundle etag stability) plus
 * one pass through `validateRows` against fake dependencies. Not exhaustive —
 * the acceptance-test-level coverage these deserve is future work, see
 * SONNET_TASKS_STATUS.md.
 */
import { describe, it, expect } from 'vitest';
import { similarity, scoreCandidates, DEFAULT_MATCH_CONFIG } from '../../src/ingest/validate/match.js';
import { pointInPolygon, bboxOf } from '../../src/shared/geo/point-in-polygon.js';
import { assembleBundle } from '../../src/server/assignments/bundle.js';
import { validateRows } from '../../src/ingest/validate/index.js';
import type { ParsedPlanRow } from '../../src/shared/contract/ingest.js';

describe('C8 fuzzy matching', () => {
  it('scores an exact match at 1', () => {
    expect(similarity('Johnson Farm LLC', 'Johnson Farm LLC')).toBe(1);
  });

  it('scores a subset business name highly (spec §8 row 7)', () => {
    const s = similarity('Bring Farms', 'Ben Bring Farms LLC');
    expect(s).toBeGreaterThan(DEFAULT_MATCH_CONFIG.suggestThreshold);
  });

  it('classifies matched vs suggested vs unmatched', () => {
    const pool = [
      { id: 'op-1', label: 'Ben Bring Farms LLC' },
      { id: 'op-2', label: 'Totally Unrelated Co' },
    ];
    const exact = scoreCandidates('Ben Bring Farms LLC', pool);
    expect(exact.status).toBe('matched');

    const partial = scoreCandidates('Bring Farms', pool);
    expect(['suggested', 'matched']).toContain(partial.status);

    const none = scoreCandidates('Zzz Nothing Like It Whatsoever', pool);
    expect(none.status).toBe('unmatched');
    expect(none.candidates).toHaveLength(0);
  });

  it('returns at most maxCandidates, highest score first', () => {
    const pool = Array.from({ length: 10 }, (_, i) => ({ id: `op-${i}`, label: 'Johnson Farm LLC' }));
    const result = scoreCandidates('Johnson Farm', pool, { ...DEFAULT_MATCH_CONFIG, maxCandidates: 3 });
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates[0]!.score).toBeGreaterThanOrEqual(result.candidates[1]!.score);
  });
});

describe('point-in-polygon', () => {
  const square: GeoJSON.Polygon = {
    type: 'Polygon',
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

  it('finds a point inside the ring', () => {
    expect(pointInPolygon({ lat: 47.5475, lon: -99.1225 }, square)).toBe(true);
  });

  it('rejects a point outside the ring', () => {
    expect(pointInPolygon({ lat: 48.05, lon: -99.8 }, square)).toBe(false);
  });

  it('computes a bbox that contains every vertex', () => {
    const [west, south, east, north] = bboxOf(square);
    expect(west).toBeCloseTo(-99.13);
    expect(east).toBeCloseTo(-99.115);
    expect(south).toBeCloseTo(47.54);
    expect(north).toBeCloseTo(47.555);
  });
});

describe('A2 assembleBundle', () => {
  const base = {
    crewOrgId: 'crew_vch_north',
    period: 'F26',
    serverTimeIso: '2026-09-28T14:02:11Z',
    specs: [],
    refConditionCode: [],
    refDeviationReason: [],
    refDefectCode: [],
    refLab: [],
    boundaries: [],
    planPoints: [],
    accessContacts: [],
    tilePack: null,
  };

  it('etag is stable across calls with identical content but different server_time', () => {
    const a = assembleBundle({ ...base, serverTimeIso: '2026-09-28T14:02:11Z' });
    const b = assembleBundle({ ...base, serverTimeIso: '2026-09-29T09:00:00Z' });
    expect(a.etag).toBe(b.etag);
  });

  it('expires_ts is server_time + expiryDays', () => {
    const bundle = assembleBundle({ ...base, expiryDays: 10 });
    const deltaDays =
      (Date.parse(bundle.expires_ts) - Date.parse(bundle.server_time)) / (24 * 60 * 60 * 1000);
    expect(deltaDays).toBeCloseTo(10);
  });
});

describe('C7 validateRows', () => {
  const boundary = {
    boundary_id: 'b-001',
    geometry: {
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
    },
    centroid_lat: 47.5475,
    centroid_lon: -99.1225,
  };

  function row(overrides: Partial<ParsedPlanRow>): ParsedPlanRow {
    return {
      source_row_no: 1,
      raw_values: {},
      plan_point_label: 'PT-001',
      lat_raw: '47.5475',
      lon_raw: '-99.1225',
      lat: 47.5475,
      lon: -99.1225,
      coord_format_detected: 'decimal',
      coord_fix_applied: null,
      boundary_id_stated: null,
      field_name: null,
      strata_label: 'D1',
      elevation_class: 'A',
      sequence_no: 1,
      access_note: null,
      prior_sample_uid: null,
      extra: {},
      operation_text: null,
      contact_name_text: null,
      contact_phone_text: null,
      contact_email_text: null,
      ...overrides,
    };
  }

  it('marks a clean in-boundary row ready', async () => {
    const result = await validateRows(
      { period_code: 'F26', project_id: null, rows: [row({})] },
      {
        boundaries: [boundary],
        existingLabelsByBoundary: new Map(),
        findOperationCandidates: async () => [],
        findContactCandidates: async () => [],
      },
    );
    expect(result.rows[0]!.row_status).toBe('ready');
    expect(result.rows[0]!.boundary_id_resolved).toBe('b-001');
  });

  it('blocks a row missing required fields', async () => {
    const result = await validateRows(
      { period_code: 'F26', project_id: null, rows: [row({ lat: null })] },
      {
        boundaries: [boundary],
        existingLabelsByBoundary: new Map(),
        findOperationCandidates: async () => [],
        findContactCandidates: async () => [],
      },
    );
    expect(result.rows[0]!.row_status).toBe('blocked');
    expect(result.rows[0]!.validation_codes).toContain('MISSING_REQUIRED_FIELD');
  });

  it('flags a point outside every boundary for review, not block', async () => {
    const result = await validateRows(
      { period_code: 'F26', project_id: null, rows: [row({ lat: 40, lon: -100 })] },
      {
        boundaries: [boundary],
        existingLabelsByBoundary: new Map(),
        findOperationCandidates: async () => [],
        findContactCandidates: async () => [],
      },
    );
    expect(result.rows[0]!.row_status).toBe('flagged');
    expect(result.rows[0]!.validation_codes).toContain('POINT_OUTSIDE_BOUNDARY');
  });

  it('blocks an in-file duplicate label', async () => {
    const result = await validateRows(
      {
        period_code: 'F26',
        project_id: null,
        rows: [row({ source_row_no: 1 }), row({ source_row_no: 2 })],
      },
      {
        boundaries: [boundary],
        existingLabelsByBoundary: new Map(),
        findOperationCandidates: async () => [],
        findContactCandidates: async () => [],
      },
    );
    expect(result.rows[1]!.row_status).toBe('blocked');
    expect(result.rows[1]!.validation_codes).toContain('DUPLICATE_LABEL_IN_FILE');
  });

  it('flags an operation text that only suggests, never creates', async () => {
    const result = await validateRows(
      { period_code: 'F26', project_id: null, rows: [row({ operation_text: 'Bring Farms' })] },
      {
        boundaries: [boundary],
        existingLabelsByBoundary: new Map(),
        findOperationCandidates: async () => [{ id: 'op-1', label: 'Ben Bring Farms LLC' }],
        findContactCandidates: async () => [],
      },
    );
    const validated = result.rows[0]!;
    expect(validated.operation_candidates.length).toBeGreaterThan(0);
    expect(validated.operation_match_id).not.toBeNull();
    // never 'matched' outright at this confidence -- it is a suggestion, and
    // the row still commits (D16: suggest, never create).
    expect(validated.row_status).not.toBe('blocked');
  });
});
