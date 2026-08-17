/**
 * Down-sync: the assignment bundle. SYNC_CONTRACT_v01 §2.
 *
 * Three rules are structural rather than stylistic, and each shows up in a type
 * below:
 *
 *  - **Replace, never patch.** Every array here replaces its local table
 *    wholesale. A corrupt local ref table is fixed by re-downloading, not by
 *    debugging a merge — so there is no delta shape and no `removed` list.
 *  - **`server_time` is the clock-drift baseline.** The device records the
 *    delta at fetch. Without it, a clock changed mid-deployment is silent.
 *  - **Access contacts only.** No other person data crosses to the device. On
 *    a contracted crew's own phone, that is the entire data-exposure story.
 */

import type {
  ContentHash,
  GeoJsonPolygon,
  IsoTimestamp,
  MediaRole,
  SchemaVersion,
  Uuid7,
} from './common.js';

export interface BundleRequest {
  crew_org_id: string;
  /** e.g. `F26`. */
  period: string;
  /** Sent as `If-None-Match`; a match returns 304 and no body. */
  etag?: string;
}

export interface ProjectSamplingSpec {
  spec_id: string;
  project_id: string;
  protocol_version: string;
  period_code: string;
  depth_top_cm: number;
  depth_bottom_cm: number;
  depth_increments_json: Array<[number, number]> | null;
  overdrill_cm: number | null;
  cores_per_composite_min: number | null;
  cores_per_composite_max: number | null;
  composite_radius_m: number | null;
  bd_core_required: boolean;
  bag_scheme: string;
  required_media_roles: MediaRole[];
  gps_accuracy_required_m: number;
  min_gps_fix_count: number;
  max_plan_offset_m_warn: number;
  max_plan_offset_m_block: number;
  default_lab_id: string | null;
}

export interface RefConditionCode {
  condition_code: string;
  code_set_version: string;
  condition_group: string | null;
  display_label: string | null;
  value_type: 'none' | 'band' | 'number' | 'text' | null;
  value_options: string[] | null;
  sort_order: number | null;
}

export interface RefDeviationReason {
  deviation_reason_code: string;
  display_label: string | null;
  requires_note: boolean;
  requires_photo: boolean;
  is_skip_reason: boolean;
}

export interface RefDefectCode {
  defect_code: string;
  display_label: string | null;
  default_severity: string | null;
  raised_by: string | null;
}

export interface RefLab {
  lab_id: string;
  lab_name: string | null;
  /** Nullable by design — the scanner reports the actual symbology. */
  barcode_symbology: string | null;
  /** Advisory format check only. Never used to reject a scan. */
  barcode_pattern: string | null;
}

export interface AssignedBoundary {
  boundary_id: string;
  property_id: string | null;
  property_name: string | null;
  operation_name: string | null;
  geojson: GeoJsonPolygon;
  /** `[west, south, east, north]` — fast pre-filter for map and PIP. */
  bbox: [number, number, number, number] | null;
  centroid_lat: number | null;
  centroid_lon: number | null;
  geom_acres: number | null;
  trs_canonical: string | null;
  access_note: string | null;
  plan_id: string | null;
  spec_id: string | null;
  period_code: string | null;
  sort_order: number | null;
}

export interface BundlePlanPoint {
  plan_point_id: string;
  plan_id: string | null;
  boundary_id: string;
  plan_point_label: string | null;
  planned_lat: number;
  planned_lon: number;
  strata_label: string | null;
  elevation_class: string | null;
  prior_sample_uid: string | null;
  prior_lat: number | null;
  prior_lon: number | null;
  sequence_no: number | null;
  access_note: string | null;
}

/** The only person data on the device. Nothing else crosses. */
export interface AccessContact {
  contact_id: string;
  boundary_id: string;
  person_id: string | null;
  display_name: string | null;
  role_label: 'owner' | 'operator' | 'property_manager' | 'row_contact' | string | null;
  phone: string | null;
  is_primary: boolean;
}

export interface TilePackRef {
  version: string;
  url: string;
  bytes: number;
  sha256: string;
}

export interface AssignmentBundle {
  bundle_id: Uuid7;
  etag: string;
  schema_version: SchemaVersion;
  /** Clock-drift baseline. The device stores the delta at fetch. */
  server_time: IsoTimestamp;
  /**
   * Warned at seven days out; refuses to start a *new* visit past it. It never
   * blocks completing or syncing work already begun — stranding a crew's day
   * is worse than a stale contact list.
   */
  expires_ts: IsoTimestamp;
  specs: ProjectSamplingSpec[];
  ref_condition_code: RefConditionCode[];
  ref_deviation_reason: RefDeviationReason[];
  ref_defect_code: RefDefectCode[];
  ref_lab: RefLab[];
  boundaries: AssignedBoundary[];
  plan_points: BundlePlanPoint[];
  access_contacts: AccessContact[];
  tile_pack: TilePackRef | null;
}

/** 304 carries no body; the caller keeps what it has. */
export type BundleResponse =
  | { status: 'ok'; bundle: AssignmentBundle }
  | { status: 'not_modified'; etag: string };

export type { ContentHash };
