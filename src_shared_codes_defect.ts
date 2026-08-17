/**
 * Defect codes — server-side and device-reported issues
 * Source: SAMPLING_SCHEMA_v01.md §4.8, SCHEMA_AND_SYNC_ADDENDUM_v02.md §3.1 & §4.2
 * These are pushed to the device as part of the assignment bundle.
 */

export type DefectSeverity = 'blocking' | 'review' | 'advisory';
export type DefectSource = 'device' | 'server_rule' | 'analyst';

export interface DefectCode {
  code: string;
  displayLabel: string;
  defaultSeverity: DefectSeverity;
  raisedBy: DefectSource;
  isActive: boolean;
}

export const DEFECT_CODES: Record<string, DefectCode> = {
  // Device-detected
  NO_GPS_FIX: {
    code: 'NO_GPS_FIX',
    displayLabel: 'No GPS fix acquired',
    defaultSeverity: 'review',
    raisedBy: 'device',
    isActive: true,
  },
  GPS_ACCURACY_EXCEEDED: {
    code: 'GPS_ACCURACY_EXCEEDED',
    displayLabel: 'GPS accuracy worse than spec',
    defaultSeverity: 'review',
    raisedBy: 'device',
    isActive: true,
  },
  MANUAL_POSITION: {
    code: 'MANUAL_POSITION',
    displayLabel: 'Position manually pinned on map',
    defaultSeverity: 'advisory',
    raisedBy: 'device',
    isActive: true,
  },
  BARCODE_UNREAD: {
    code: 'BARCODE_UNREAD',
    displayLabel: 'Barcode could not be read',
    defaultSeverity: 'blocking',
    raisedBy: 'device',
    isActive: true,
  },
  DEPTH_SHORTFALL: {
    code: 'DEPTH_SHORTFALL',
    displayLabel: 'Sample depth is less than spec',
    defaultSeverity: 'review',
    raisedBy: 'device',
    isActive: true,
  },

  // Server-side rules
  BARCODE_DUPLICATE: {
    code: 'BARCODE_DUPLICATE',
    displayLabel: 'Barcode already exists in released plan',
    defaultSeverity: 'blocking',
    raisedBy: 'server_rule',
    isActive: true,
  },
  BARCODE_FORMAT_UNEXPECTED: {
    code: 'BARCODE_FORMAT_UNEXPECTED',
    displayLabel: 'Barcode does not match lab pattern',
    defaultSeverity: 'review',
    raisedBy: 'server_rule',
    isActive: true,
  },
  MISSING_REQUIRED_MEDIA: {
    code: 'MISSING_REQUIRED_MEDIA',
    displayLabel: 'Missing one or more required photo roles',
    defaultSeverity: 'review',
    raisedBy: 'server_rule',
    isActive: true,
  },
  MEDIA_GALLERY_SOURCED: {
    code: 'MEDIA_GALLERY_SOURCED',
    displayLabel: 'Photo from camera roll attached to required role',
    defaultSeverity: 'review',
    raisedBy: 'server_rule',
    isActive: true,
  },
  MEDIA_UPLOAD_STALLED: {
    code: 'MEDIA_UPLOAD_STALLED',
    displayLabel: 'Media upload has stalled',
    defaultSeverity: 'advisory',
    raisedBy: 'server_rule',
    isActive: true,
  },
  POINT_OUTSIDE_BOUNDARY: {
    code: 'POINT_OUTSIDE_BOUNDARY',
    displayLabel: 'Sample point is outside any assigned boundary',
    defaultSeverity: 'blocking',
    raisedBy: 'server_rule',
    isActive: true,
  },
  PLAN_OFFSET_EXCEEDED: {
    code: 'PLAN_OFFSET_EXCEEDED',
    displayLabel: 'Offset from plan point exceeds spec without deviation reason',
    defaultSeverity: 'review',
    raisedBy: 'server_rule',
    isActive: true,
  },
  NO_DEVIATION_REASON: {
    code: 'NO_DEVIATION_REASON',
    displayLabel: 'Deviation from spec recorded but no reason provided',
    defaultSeverity: 'review',
    raisedBy: 'server_rule',
    isActive: true,
  },
  CLOCK_DRIFT_SUSPECTED: {
    code: 'CLOCK_DRIFT_SUSPECTED',
    displayLabel: 'Device clock may have changed mid-deployment',
    defaultSeverity: 'review',
    raisedBy: 'server_rule',
    isActive: true,
  },
  EXIF_POSITION_MISMATCH: {
    code: 'EXIF_POSITION_MISMATCH',
    displayLabel: 'Photo EXIF position differs from sample position',
    defaultSeverity: 'advisory',
    raisedBy: 'server_rule',
    isActive: true,
  },
  PLAN_POINT_UNSAMPLED: {
    code: 'PLAN_POINT_UNSAMPLED',
    displayLabel: 'Plan point reached close date without being sampled',
    defaultSeverity: 'review',
    raisedBy: 'server_rule',
    isActive: true,
  },
  LATE_SYNC: {
    code: 'LATE_SYNC',
    displayLabel: 'Record synced after expected window',
    defaultSeverity: 'advisory',
    raisedBy: 'server_rule',
    isActive: true,
  },
};

// Codes that push down to the field as "yesterday's flags" (defect-down-sync)
export const FIELD_VISIBLE_DEFECT_CODES = [
  'BARCODE_DUPLICATE',
  'BARCODE_UNREAD',
  'MISSING_REQUIRED_MEDIA',
  'NO_GPS_FIX',
  'GPS_ACCURACY_EXCEEDED',
  'POINT_OUTSIDE_BOUNDARY',
  'PLAN_POINT_UNSAMPLED',
  'DEPTH_SHORTFALL',
];

// Codes that stay in the office (crew cannot act on them)
export const OFFICE_ONLY_DEFECT_CODES = [
  'CLOCK_DRIFT_SUSPECTED',
  'LATE_SYNC',
  'EXIF_POSITION_MISMATCH',
  'MEDIA_GALLERY_SOURCED',
];
