/**
 * The payload shapes carried by `SyncRecord.payload`, one per entity type.
 *
 * These mirror the device tables in `device_sqlite_v01.sql` (+ v02 addendum)
 * minus the purely local columns — `sync_state`, `local_status`,
 * `local_offset_from_plan_m`. That last omission is deliberate and load-bearing:
 * **the device's offset figure is advisory and is not stored.** One
 * implementation, one answer, computed server-side (contract §6 step 6).
 */

import type {
  BarcodeCaptureMethod,
  CaptureSource,
  IsoDate,
  IsoTimestamp,
  MediaRole,
  PositionSource,
  Uuid7,
} from './common.js';

export interface FieldVisitPayload {
  visit_id: Uuid7;
  boundary_id: string;
  plan_id: string | null;
  spec_id: string | null;
  crew_org_id: string | null;
  sampler_person_id: string | null;
  device_id: string | null;
  access_contact_person_id: string | null;
  visit_date: IsoDate | null;
  started_ts: IsoTimestamp | null;
  ended_ts: IsoTimestamp | null;
  status: 'in_progress' | 'complete' | 'abandoned' | string;
  abandon_reason_code: string | null;
  visit_note: string | null;
  app_version: string | null;
  is_pilot?: boolean;
}

export interface SamplePointPayload {
  sample_uid: Uuid7;
  visit_id: Uuid7;
  /** NULL = field-added sample. */
  plan_point_id: string | null;
  lat: number | null;
  lon: number | null;
  gps_accuracy_m: number | null;
  altitude_m: number | null;
  altitude_accuracy_m: number | null;
  position_provider: string | null;
  position_source: PositionSource | null;
  fix_count: number | null;
  fix_spread_m: number | null;
  /** The raw fixes, for forensics. Kept verbatim; never averaged server-side. */
  fix_samples_json: string | null;
  deviation_reason_code: string | null;
  captured_ts_device: IsoTimestamp | null;
  captured_ts_utc_offset: number | null;
  /** Monotonic. This is how a clock changed mid-deployment becomes visible. */
  device_uptime_ms: number | null;
  sampler_person_id: string | null;
  device_id: string | null;
  period_code: string | null;
  spec_id: string | null;
  protocol_version: string | null;
  /** Exception capture only — NULL means "per spec". */
  depth_achieved_cm: number | null;
  refusal_code: string | null;
  cores_taken: number | null;
  bd_core_taken: boolean | null;
  note: string | null;
  supersedes_sample_uid: string | null;
}

export interface SampleBagPayload {
  bag_id: Uuid7;
  sample_uid: Uuid7;
  bag_seq: number | null;
  bag_role: string | null;
  depth_top_cm: number | null;
  depth_bottom_cm: number | null;
  lab_id: string | null;
  /** VERBATIM from the scanner. Never normalised in place. */
  barcode_raw: string | null;
  barcode_symbology: string | null;
  barcode_capture_method: BarcodeCaptureMethod | null;
  barcode_scanned_ts: IsoTimestamp | null;
  void_flag: boolean | null;
  void_reason_code: string | null;
}

export interface SampleConditionPayload {
  condition_id: Uuid7;
  sample_uid: Uuid7;
  condition_code: string;
  condition_value: string | null;
  code_set_version: string | null;
}

export interface MediaMetaPayload {
  media_id: Uuid7;
  /** Bare hex SHA-256 of the stored bytes. Addresses the object store. */
  content_hash: string;
  sample_uid: string | null;
  bag_id: string | null;
  visit_id: string | null;
  media_role: MediaRole;
  is_required_role: boolean;
  capture_order: number | null;
  capture_ts_device: IsoTimestamp | null;
  /** Preserved verbatim. Independent corroboration of the app's own fix. */
  exif_lat: number | null;
  exif_lon: number | null;
  exif_ts: IsoTimestamp | null;
  exif_raw: unknown | null;
  exif_gps_present: boolean | null;
  bytes: number;
  width_px: number | null;
  height_px: number | null;
  mime_type: string | null;
  /** Addendum §3.1. Required roles accept `in_app_camera` only. */
  capture_source: CaptureSource;
  device_id: string | null;
}

export interface LocalDefectPayload {
  defect_id: Uuid7;
  sample_uid: string | null;
  bag_id: string | null;
  visit_id: string | null;
  plan_point_id: string | null;
  defect_code: string;
  severity: string | null;
  detected_ts: IsoTimestamp | null;
  detail: string | null;
}

export interface DefectAckPayload {
  defect_id: string;
  acked_ts: IsoTimestamp;
  device_id: string | null;
  sampler_person_id: string | null;
}

export interface AppEventPayload {
  event_id: string;
  event_ts: IsoTimestamp;
  event_type: string;
  detail_json: unknown | null;
}

/** Discriminated map from entity type to payload, for exhaustive handling. */
export interface EntityPayloadMap {
  field_visit: FieldVisitPayload;
  sample_point: SamplePointPayload;
  sample_bag: SampleBagPayload;
  sample_condition: SampleConditionPayload;
  media_meta: MediaMetaPayload;
  local_defect: LocalDefectPayload;
  defect_ack: DefectAckPayload;
  app_event: AppEventPayload;
}

/** The client key each entity is upserted on. Contract §1 property 2. */
export const ENTITY_PRIMARY_KEY: Record<keyof EntityPayloadMap, string> = {
  field_visit: 'visit_id',
  sample_point: 'sample_uid',
  sample_bag: 'bag_id',
  sample_condition: 'condition_id',
  media_meta: 'media_id',
  local_defect: 'defect_id',
  defect_ack: 'defect_id',
  app_event: 'event_id',
};

/**
 * Parent entity per child, for the pending-parent hold. The server accepts
 * children ahead of parents and holds them for 30 days — a device wiped
 * mid-deployment should not orphan the records that did arrive.
 */
export const ENTITY_PARENT: Partial<
  Record<keyof EntityPayloadMap, { entity: keyof EntityPayloadMap; field: string }>
> = {
  sample_point: { entity: 'field_visit', field: 'visit_id' },
  sample_bag: { entity: 'sample_point', field: 'sample_uid' },
  sample_condition: { entity: 'sample_point', field: 'sample_uid' },
};

export const PENDING_PARENT_HOLD_DAYS = 30;
