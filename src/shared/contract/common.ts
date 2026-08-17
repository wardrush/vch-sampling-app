/**
 * Shared primitives for the wire surface.
 *
 * F0.4 · transcribed from SYNC_CONTRACT_v01 §2–§4 and SCHEMA_AND_SYNC_ADDENDUM_v02 §4.3.
 *
 * Every timestamp on the wire is an ISO-8601 UTC string, never a Date. Dates do
 * not survive JSON, and a client that parses a timestamp it did not need to
 * parse is a client that can get the timezone wrong. Parse at the point of use.
 */

/** ISO-8601 instant in UTC, e.g. `2026-10-02T23:11:04Z`. */
export type IsoTimestamp = string;

/** ISO-8601 calendar date, e.g. `2026-10-02`. */
export type IsoDate = string;

/** UUIDv7, generated on the client. Time-ordered, sortable, collision-safe. */
export type Uuid7 = string;

/** Lowercase hex SHA-256, prefixed. Content addresses everything. */
export type ContentHash = `sha256:${string}`;

/** Bare lowercase hex SHA-256 — what Snowflake stores in `*_HASH` columns. */
export type HexHash = string;

/** The wire schema version. Bumped when a payload shape changes incompatibly. */
export const SCHEMA_VERSION = '1.0';

export type SchemaVersion = string;

/**
 * Entity types that ride in a sync batch. `media_meta` carries a photo's
 * metadata; the bytes are a separate, later, larger transfer.
 */
export type SyncEntityType =
  | 'field_visit'
  | 'sample_point'
  | 'sample_bag'
  | 'sample_condition'
  | 'media_meta'
  | 'local_defect'
  | 'defect_ack'
  | 'app_event';

/** SYNC_CONTRACT §7 — position provenance, permanent and audit-bearing. */
export type PositionSource = 'gps' | 'manual_map_pin' | 'plan_inherited';

/**
 * Addendum §3.1. The single most important audit distinction in the media
 * table. A photograph picked from the camera roll is not evidence of having
 * been at the hole.
 */
export type CaptureSource = 'in_app_camera' | 'device_gallery' | 'unknown';

export type MediaRole = 'label_photo' | 'core_photo' | 'site_photo' | 'issue_photo' | 'other';

export type BarcodeCaptureMethod = 'scan' | 'manual_entry' | 'photo_recovered';

export type DefectSeverity = 'blocking' | 'review' | 'advisory';

export type DefectRaisedBy = 'device' | 'server_rule' | 'analyst';

export type ReviewState = 'captured' | 'screened' | 'needs_review' | 'accepted' | 'rejected';

/** Longitude first is a GeoJSON rule and a recurring source of swapped pairs. */
export interface GeoJsonPolygon {
  type: 'Polygon' | 'MultiPolygon';
  coordinates: number[][][] | number[][][][];
}

/** A problem the caller can act on, in the same shape everywhere. */
export interface ContractError {
  code: string;
  detail?: string;
  retryable: boolean;
}
