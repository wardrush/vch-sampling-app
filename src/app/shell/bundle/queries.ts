/**
 * B4/B5/B7 — read helpers over the bundle-replaced device tables
 * (`src/shared/db/migrations/001_device_v01.ts`). One place that knows the
 * column names, so the three screens that read this data do not each
 * hand-roll SQL against the same schema.
 */

import type { SqlDatabase } from '../../../shared/db/types.js';
import type { GeoJsonPolygon, MediaRole } from '../../../shared/contract/common.js';

/** `local_status` values a plan point can carry on-device. Never synced verbatim
 *  — the server derives the authoritative review state from what actually synced. */
export type LocalPointStatus = 'pending' | 'sampled' | 'skipped';

export interface BoundarySummary {
  boundary_id: string;
  property_name: string | null;
  geojson: GeoJsonPolygon;
  geom_acres: number | null;
  totalPoints: number;
  sampledPoints: number;
  skippedPoints: number;
  primaryContactName: string | null;
  primaryContactPhone: string | null;
}

export async function listBoundarySummaries(db: SqlDatabase): Promise<BoundarySummary[]> {
  const boundaries = await db.all<{
    boundary_id: string;
    property_name: string | null;
    geojson: string;
    geom_acres: number | null;
    sort_order: number | null;
  }>(
    `SELECT boundary_id, property_name, geojson, geom_acres, sort_order
       FROM assigned_boundary
      ORDER BY sort_order IS NULL, sort_order, boundary_id`,
  );

  const out: BoundarySummary[] = [];
  for (const b of boundaries) {
    const counts = await db.all<{ local_status: LocalPointStatus; n: number }>(
      `SELECT local_status, COUNT(*) AS n FROM sample_plan_point WHERE boundary_id = ? GROUP BY local_status`,
      [b.boundary_id],
    );
    let total = 0;
    let sampled = 0;
    let skipped = 0;
    for (const c of counts) {
      total += Number(c.n);
      if (c.local_status === 'sampled') sampled = Number(c.n);
      if (c.local_status === 'skipped') skipped = Number(c.n);
    }

    const contact = await db.all<{ display_name: string | null; phone: string | null }>(
      `SELECT display_name, phone FROM access_contact WHERE boundary_id = ? ORDER BY is_primary DESC LIMIT 1`,
      [b.boundary_id],
    );

    out.push({
      boundary_id: b.boundary_id,
      property_name: b.property_name,
      geojson: JSON.parse(b.geojson) as GeoJsonPolygon,
      geom_acres: b.geom_acres,
      totalPoints: total,
      sampledPoints: sampled,
      skippedPoints: skipped,
      primaryContactName: contact[0]?.display_name ?? null,
      primaryContactPhone: contact[0]?.phone ?? null,
    });
  }
  return out;
}

export interface DevicePlanPoint {
  plan_point_id: string;
  boundary_id: string;
  plan_point_label: string | null;
  planned_lat: number;
  planned_lon: number;
  strata_label: string | null;
  elevation_class: string | null;
  sequence_no: number | null;
  local_status: LocalPointStatus;
}

export async function listPlanPoints(db: SqlDatabase, boundaryId: string): Promise<DevicePlanPoint[]> {
  return db.all<DevicePlanPoint>(
    `SELECT plan_point_id, boundary_id, plan_point_label, planned_lat, planned_lon, strata_label,
            elevation_class, sequence_no, local_status
       FROM sample_plan_point
      WHERE boundary_id = ?
      ORDER BY sequence_no IS NULL, sequence_no, plan_point_id`,
    [boundaryId],
  );
}

export async function getPlanPoint(db: SqlDatabase, planPointId: string): Promise<DevicePlanPoint | null> {
  const rows = await db.all<DevicePlanPoint>(
    `SELECT plan_point_id, boundary_id, plan_point_label, planned_lat, planned_lon, strata_label,
            elevation_class, sequence_no, local_status
       FROM sample_plan_point WHERE plan_point_id = ?`,
    [planPointId],
  );
  return rows[0] ?? null;
}

export interface DeviceBoundary {
  boundary_id: string;
  property_name: string | null;
  geojson: GeoJsonPolygon;
  geom_acres: number | null;
}

export async function getBoundary(db: SqlDatabase, boundaryId: string): Promise<DeviceBoundary | null> {
  const rows = await db.all<{
    boundary_id: string;
    property_name: string | null;
    geojson: string;
    geom_acres: number | null;
  }>(`SELECT boundary_id, property_name, geojson, geom_acres FROM assigned_boundary WHERE boundary_id = ?`, [
    boundaryId,
  ]);
  const row = rows[0];
  if (!row) return null;
  return { ...row, geojson: JSON.parse(row.geojson) as GeoJsonPolygon };
}

export async function setPlanPointStatus(
  db: SqlDatabase,
  planPointId: string,
  status: LocalPointStatus,
): Promise<void> {
  await db.run(`UPDATE sample_plan_point SET local_status = ? WHERE plan_point_id = ?`, [status, planPointId]);
}

export interface DeviceSpec {
  spec_id: string;
  project_id: string | null;
  protocol_version: string | null;
  period_code: string | null;
  depth_top_cm: number | null;
  depth_bottom_cm: number | null;
  cores_per_composite_min: number | null;
  cores_per_composite_max: number | null;
  bd_core_required: boolean;
  required_media_roles: MediaRole[];
  gps_accuracy_required_m: number;
  min_gps_fix_count: number;
  max_plan_offset_m_warn: number;
  max_plan_offset_m_block: number;
  default_lab_id: string | null;
}

/**
 * The spec that governs a capture. The demo fixture carries exactly one, so
 * "the first spec on file" is correct for this wave; a real multi-spec
 * pilot needs `assigned_boundary.spec_id` wired through, named as a gap in
 * the wave report rather than guessed at here.
 */
export async function getPrimarySpec(db: SqlDatabase): Promise<DeviceSpec | null> {
  const rows = await db.all<{
    spec_id: string;
    project_id: string | null;
    protocol_version: string | null;
    period_code: string | null;
    depth_top_cm: number | null;
    depth_bottom_cm: number | null;
    cores_per_composite_min: number | null;
    cores_per_composite_max: number | null;
    bd_core_required: number | null;
    required_media_roles: string | null;
    gps_accuracy_required_m: number;
    min_gps_fix_count: number;
    max_plan_offset_m_warn: number;
    max_plan_offset_m_block: number;
    default_lab_id: string | null;
  }>(`SELECT * FROM project_sampling_spec LIMIT 1`);
  const row = rows[0];
  if (!row) return null;
  return {
    ...row,
    bd_core_required: row.bd_core_required === 1,
    required_media_roles: row.required_media_roles ? (JSON.parse(row.required_media_roles) as MediaRole[]) : [],
  };
}

export interface DeviceRefLab {
  lab_id: string;
  lab_name: string | null;
  barcode_symbology: string | null;
  barcode_pattern: string | null;
}

export async function getRefLabs(db: SqlDatabase): Promise<DeviceRefLab[]> {
  return db.all<DeviceRefLab>(`SELECT lab_id, lab_name, barcode_symbology, barcode_pattern FROM ref_lab`);
}

export interface DeviceConditionCode {
  condition_code: string;
  condition_group: string | null;
  display_label: string | null;
  value_type: string | null;
  value_options: string[] | null;
  sort_order: number | null;
}

export async function getRefConditionCodes(db: SqlDatabase): Promise<DeviceConditionCode[]> {
  const rows = await db.all<{
    condition_code: string;
    condition_group: string | null;
    display_label: string | null;
    value_type: string | null;
    value_options: string | null;
    sort_order: number | null;
  }>(`SELECT * FROM ref_condition_code ORDER BY sort_order IS NULL, sort_order`);
  return rows.map((r) => ({
    ...r,
    value_options: r.value_options ? (JSON.parse(r.value_options) as string[]) : null,
  }));
}

export interface BundleManifestRow {
  bundle_id: string;
  fetched_ts: string;
  expires_ts: string;
  boundary_count: number | null;
  plan_point_count: number | null;
}

export async function getLatestBundleManifest(db: SqlDatabase): Promise<BundleManifestRow | null> {
  const rows = await db.all<BundleManifestRow>(
    `SELECT bundle_id, fetched_ts, expires_ts, boundary_count, plan_point_count
       FROM bundle_manifest ORDER BY fetched_ts DESC LIMIT 1`,
  );
  return rows[0] ?? null;
}
