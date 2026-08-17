/**
 * Validation codes — ingest-time and capture-time validation rules
 * Source: PLAN_INGEST_SPEC_v01.md §5 (ingest rules), SAMPLING_APP_PLAN_v02.md §3 (capture)
 */

export type ValidationType = 'blocking' | 'review' | 'advisory';

export interface ValidationCode {
  code: string;
  displayLabel: string;
  validationType: ValidationType;
  description: string;
}

/**
 * Ingest validation codes (from PLAN_INGEST_SPEC_v01.md §5)
 */
export const INGEST_VALIDATION_CODES: Record<string, ValidationCode> = {
  // Blocking: row will not commit
  MISSING_REQUIRED_COLUMN: {
    code: 'MISSING_REQUIRED_COLUMN',
    displayLabel: 'Missing required column',
    validationType: 'blocking',
    description:
      'Row is missing a required value (plan_point_label, lat, or lon)',
  },
  COORDINATE_UNPARSEABLE: {
    code: 'COORDINATE_UNPARSEABLE',
    displayLabel: 'Coordinate unparseable',
    validationType: 'blocking',
    description: 'Latitude or longitude could not be parsed',
  },
  COORDINATE_OUT_OF_RANGE: {
    code: 'COORDINATE_OUT_OF_RANGE',
    displayLabel: 'Coordinate out of range',
    validationType: 'blocking',
    description: 'Latitude > 90 or < -90, or longitude > 180 or < -180',
  },
  SWAPPED_LAT_LON: {
    code: 'SWAPPED_LAT_LON',
    displayLabel: 'Latitude and longitude may be swapped',
    validationType: 'blocking',
    description:
      'Longitude is positive in US context, or lat/lon values suggest reversal. Offered as one-click fix.',
  },
  DUPLICATE_POINT_ID_IN_FILE: {
    code: 'DUPLICATE_POINT_ID_IN_FILE',
    displayLabel: 'Duplicate point ID within file',
    validationType: 'blocking',
    description: 'This plan_point_label appears more than once in the same import',
  },
  DUPLICATE_POINT_ID_EXISTING: {
    code: 'DUPLICATE_POINT_ID_EXISTING',
    displayLabel: 'Duplicate point ID against existing plan',
    validationType: 'blocking',
    description:
      'This plan_point_label already exists in a released plan for this boundary and period',
  },

  // Review: row commits but flagged
  POINT_OUTSIDE_BOUNDARY: {
    code: 'POINT_OUTSIDE_BOUNDARY',
    displayLabel: 'Point outside any boundary',
    validationType: 'review',
    description:
      'Parsed coordinate does not fall within any assigned boundary polygon',
  },
  POINT_IN_DIFFERENT_BOUNDARY: {
    code: 'POINT_IN_DIFFERENT_BOUNDARY',
    displayLabel: 'Point in different boundary than stated',
    validationType: 'review',
    description:
      'Point falls within a different boundary than the one specified in boundary_id',
  },
  POINTS_TOO_CLOSE: {
    code: 'POINTS_TOO_CLOSE',
    displayLabel: 'Points closer than composite radius',
    validationType: 'review',
    description: 'Two points within 2 m of each other (below protocol composite radius)',
  },
  OPERATION_FUZZY_MATCH_LOW_CONFIDENCE: {
    code: 'OPERATION_FUZZY_MATCH_LOW_CONFIDENCE',
    displayLabel: 'Operation fuzzy match below threshold',
    validationType: 'review',
    description: 'Farmer/operation name fuzzy-matches an existing operation below confidence threshold',
  },
  OPERATION_NO_MATCH: {
    code: 'OPERATION_NO_MATCH',
    displayLabel: 'Operation does not match',
    validationType: 'review',
    description: 'Farmer/operation name does not match any existing operation',
  },
  CONTACT_NO_MATCH: {
    code: 'CONTACT_NO_MATCH',
    displayLabel: 'Contact does not match',
    validationType: 'review',
    description: 'Contact name/phone does not match any existing person',
  },
  COORDINATE_IMPLAUSIBLE_DISTANCE: {
    code: 'COORDINATE_IMPLAUSIBLE_DISTANCE',
    displayLabel: 'Coordinate implausibly far from assigned ground',
    validationType: 'review',
    description: 'Point is unusually far from any assigned boundary for the period (catches wrong-file uploads)',
  },

  // Advisory: row commits with no flag
  UNMAPPED_COLUMNS_PRESENT: {
    code: 'UNMAPPED_COLUMNS_PRESENT',
    displayLabel: 'Unmapped columns present',
    validationType: 'advisory',
    description:
      'File contains columns that were not recognized or mapped. These are preserved in extra_json.',
  },
  ELEVATION_CLASS_UNEXPECTED: {
    code: 'ELEVATION_CLASS_UNEXPECTED',
    displayLabel: 'Elevation class value unexpected',
    validationType: 'advisory',
    description: 'Elevation class value is not A or B',
  },
  NO_STRATA_LABEL: {
    code: 'NO_STRATA_LABEL',
    displayLabel: 'No strata label provided',
    validationType: 'advisory',
    description: 'No strata_label value on any row in this import',
  },
};

/**
 * Capture-time validation codes (from sampling app, represented here for consistency)
 */
export const CAPTURE_VALIDATION_CODES: Record<string, ValidationCode> = {
  GPS_ACCURACY_EXCEEDED: {
    code: 'GPS_ACCURACY_EXCEEDED',
    displayLabel: 'GPS accuracy worse than spec',
    validationType: 'review',
    description: 'Acquired GPS fix does not meet spec accuracy threshold',
  },
  OFFSET_EXCEEDS_WARN_THRESHOLD: {
    code: 'OFFSET_EXCEEDS_WARN_THRESHOLD',
    displayLabel: 'Offset from plan exceeds warning threshold',
    validationType: 'review',
    description: 'Sample is offset from plan point by > warn_threshold meters',
  },
  OFFSET_EXCEEDS_BLOCK_THRESHOLD: {
    code: 'OFFSET_EXCEEDS_BLOCK_THRESHOLD',
    displayLabel: 'Offset from plan exceeds block threshold',
    validationType: 'blocking',
    description: 'Sample is offset from plan point by > block_threshold meters; requires deviation reason',
  },
  MISSING_REQUIRED_MEDIA_ROLE: {
    code: 'MISSING_REQUIRED_MEDIA_ROLE',
    displayLabel: 'Missing required photo role',
    validationType: 'blocking',
    description: 'One or more required photo roles (label, core, site) not provided',
  },
  DEPTH_BELOW_SPEC: {
    code: 'DEPTH_BELOW_SPEC',
    displayLabel: 'Sample depth below spec',
    validationType: 'review',
    description: 'Sampled depth is less than spec target depth',
  },
  BARCODE_UNREAD: {
    code: 'BARCODE_UNREAD',
    displayLabel: 'Barcode could not be read',
    validationType: 'blocking',
    description: 'Barcode scanner failed to read; manual entry required',
  },
};
