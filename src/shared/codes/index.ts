/**
 * Code sets. Partial — **F0.5 (Lane C, [HAIKU]) owns the full transcription**
 * of condition codes, deviation reasons and validation codes from the DDL and
 * addendum §4.2.
 *
 * What is here is only what the Opus-tagged server modules import: the defect
 * codes the pipeline and the rule harness raise by name, and the field-
 * visibility split. Adding to this file is F0.5's job, not a rewrite of it.
 */

import type { DefectSeverity } from '../contract/common.js';

export const DEFECT_CODE = {
  BARCODE_DUPLICATE: 'BARCODE_DUPLICATE',
  BARCODE_UNREAD: 'BARCODE_UNREAD',
  MISSING_REQUIRED_MEDIA: 'MISSING_REQUIRED_MEDIA',
  NO_GPS_FIX: 'NO_GPS_FIX',
  GPS_ACCURACY_EXCEEDED: 'GPS_ACCURACY_EXCEEDED',
  POINT_OUTSIDE_BOUNDARY: 'POINT_OUTSIDE_BOUNDARY',
  PLAN_POINT_UNSAMPLED: 'PLAN_POINT_UNSAMPLED',
  DEPTH_SHORTFALL: 'DEPTH_SHORTFALL',
  OFFSET_EXCEEDED_NO_REASON: 'OFFSET_EXCEEDED_NO_REASON',
  CLOCK_DRIFT_SUSPECTED: 'CLOCK_DRIFT_SUSPECTED',
  LATE_SYNC: 'LATE_SYNC',
  EXIF_POSITION_MISMATCH: 'EXIF_POSITION_MISMATCH',
  MEDIA_GALLERY_SOURCED: 'MEDIA_GALLERY_SOURCED',
  MANUAL_POSITION: 'MANUAL_POSITION',
  GEOM_INVALID: 'GEOM_INVALID',
  IMPORT_OPERATION_UNRESOLVED: 'IMPORT_OPERATION_UNRESOLVED',
  IMPORT_CONTACT_UNRESOLVED: 'IMPORT_CONTACT_UNRESOLVED',
} as const;

export type DefectCode = (typeof DEFECT_CODE)[keyof typeof DEFECT_CODE];

/**
 * Default severity per code. `REF.DEFECT_CODE` is authoritative at runtime —
 * this map is the fallback for a rule that fires before reference data loads,
 * and the compile-time record of what each code is *for*.
 */
export const DEFAULT_SEVERITY: Record<DefectCode, DefectSeverity> = {
  BARCODE_DUPLICATE: 'review',
  BARCODE_UNREAD: 'review',
  MISSING_REQUIRED_MEDIA: 'blocking',
  NO_GPS_FIX: 'blocking',
  GPS_ACCURACY_EXCEEDED: 'review',
  POINT_OUTSIDE_BOUNDARY: 'blocking',
  PLAN_POINT_UNSAMPLED: 'review',
  DEPTH_SHORTFALL: 'review',
  OFFSET_EXCEEDED_NO_REASON: 'review',
  CLOCK_DRIFT_SUSPECTED: 'review',
  LATE_SYNC: 'advisory',
  EXIF_POSITION_MISMATCH: 'review',
  MEDIA_GALLERY_SOURCED: 'review',
  MANUAL_POSITION: 'advisory',
  GEOM_INVALID: 'blocking',
  IMPORT_OPERATION_UNRESOLVED: 'review',
  IMPORT_CONTACT_UNRESOLVED: 'advisory',
};

/**
 * Addendum §4.2. `REF.DEFECT_FIELD_VISIBILITY` is authoritative; this is the
 * seed and the fallback. Everything not `true` here stays in the office
 * because a crew cannot act on it.
 */
export const VISIBLE_TO_FIELD: Record<DefectCode, boolean> = {
  BARCODE_DUPLICATE: true,
  BARCODE_UNREAD: true,
  MISSING_REQUIRED_MEDIA: true,
  NO_GPS_FIX: true,
  GPS_ACCURACY_EXCEEDED: true,
  POINT_OUTSIDE_BOUNDARY: true,
  PLAN_POINT_UNSAMPLED: true,
  DEPTH_SHORTFALL: true,
  OFFSET_EXCEEDED_NO_REASON: false,
  CLOCK_DRIFT_SUSPECTED: false,
  LATE_SYNC: false,
  EXIF_POSITION_MISMATCH: false,
  MEDIA_GALLERY_SOURCED: false,
  MANUAL_POSITION: false,
  GEOM_INVALID: false,
  IMPORT_OPERATION_UNRESOLVED: false,
  IMPORT_CONTACT_UNRESOLVED: false,
};

/** Addendum §2.6 — the closed set of auditable actions. */
export const AUDIT_ACTION = {
  IMPORT_COMMIT: 'import_commit',
  IMPORT_RETIRE: 'import_retire',
  IMPORT_RETIRE_REFUSED: 'import_retire_refused',
  DEFECT_RESOLVE: 'defect_resolve',
  PLAN_RELEASE: 'plan_release',
  DEVICE_ENROLL: 'device_enroll',
  DEVICE_REVOKE: 'device_revoke',
  TOKEN_ISSUE: 'token_issue',
  TOKEN_REVOKE: 'token_revoke',
  SESSION_ESTABLISH: 'session_establish',
  SESSION_REFUSED: 'session_refused',
} as const;

export type AuditAction = (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION];

export type AuditSurface = 'ingest' | 'analyst' | 'admin' | 'sync';
