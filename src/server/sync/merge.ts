/**
 * Parse + MERGE into CURATED, on the client keys. Contract §6 step 2.
 *
 * **The projection below is the parse, and it is deliberately the only one.**
 * `curatedMergeSql()` takes the *source expression* as a parameter, so the
 * same SQL serves both callers:
 *
 *   - `/sync/batch` passes `PARSE_JSON(?)` — the batch just received.
 *   - the rebuild tool passes a select over `RAW.SYNC_PAYLOAD`.
 *
 * That is what makes v02 §11 criterion 5 — *`CURATED` dropped and rebuilt
 * entirely from `RAW`* — a property of the code rather than an aspiration. Two
 * parsers would make it a lie within a season, and step 1 of the pipeline
 * exists precisely to keep it true.
 *
 * Nothing derived appears here. `GEOG`, `BOUNDARY_ID`, `TRS_CANONICAL`,
 * `OFFSET_FROM_PLAN_M` and `BEARING_FROM_PLAN_DEG` are computed in one place
 * downstream (contract §6 steps 3–6). The device's own offset figure is
 * advisory and is not stored — it never reaches a column.
 */

import type { SyncEntityType } from '../../shared/contract/common.js';

interface ColumnSpec {
  /** Snowflake column. */
  column: string;
  /** Key in the record payload. */
  path: string;
  /** Cast applied to the extracted VARIANT. */
  type: string;
}

interface EntityMapping {
  table: string;
  key: string;
  columns: ColumnSpec[];
  /**
   * Extra `WHEN MATCHED` guard. Contract §1 property 5 — the server refuses to
   * mutate a record already accepted. A replay of an accepted record is not an
   * error, it simply changes nothing, which is what makes a re-POST return the
   * same acknowledgement.
   */
  matchedGuard?: string;
}

const TS = 'TIMESTAMP_NTZ';
const STR = 'VARCHAR';
const NUM = 'NUMBER';
const FLT = 'FLOAT';
const BOOL = 'BOOLEAN';

const MAPPINGS: Record<Exclude<SyncEntityType, 'defect_ack' | 'app_event'>, EntityMapping> = {
  field_visit: {
    table: 'CURATED.FIELD_VISIT',
    key: 'VISIT_ID',
    columns: [
      { column: 'VISIT_ID', path: 'visit_id', type: STR },
      { column: 'BOUNDARY_ID', path: 'boundary_id', type: STR },
      { column: 'PLAN_ID', path: 'plan_id', type: STR },
      { column: 'SPEC_ID', path: 'spec_id', type: STR },
      { column: 'CREW_ORG_ID', path: 'crew_org_id', type: STR },
      { column: 'SAMPLER_PERSON_ID', path: 'sampler_person_id', type: STR },
      { column: 'DEVICE_ID', path: 'device_id', type: STR },
      { column: 'ACCESS_CONTACT_PERSON_ID', path: 'access_contact_person_id', type: STR },
      { column: 'VISIT_DATE', path: 'visit_date', type: 'DATE' },
      { column: 'STARTED_TS', path: 'started_ts', type: TS },
      { column: 'ENDED_TS', path: 'ended_ts', type: TS },
      { column: 'STATUS', path: 'status', type: STR },
      { column: 'ABANDON_REASON_CODE', path: 'abandon_reason_code', type: STR },
      { column: 'VISIT_NOTE', path: 'visit_note', type: STR },
      { column: 'IS_PILOT', path: 'is_pilot', type: BOOL },
      { column: 'APP_VERSION', path: 'app_version', type: STR },
    ],
  },
  sample_point: {
    table: 'CURATED.SAMPLE_POINT',
    key: 'SAMPLE_UID',
    // The raw per-fix samples (`fix_samples_json`) have no curated column by
    // design — they survive verbatim in RAW.SYNC_PAYLOAD, which is where
    // forensics reads them. Adding a column is a schema decision (A12), not
    // something a parser should do quietly.
    columns: [
      { column: 'SAMPLE_UID', path: 'sample_uid', type: STR },
      { column: 'VISIT_ID', path: 'visit_id', type: STR },
      { column: 'PLAN_POINT_ID', path: 'plan_point_id', type: STR },
      { column: 'LAT', path: 'lat', type: FLT },
      { column: 'LON', path: 'lon', type: FLT },
      { column: 'GPS_ACCURACY_M', path: 'gps_accuracy_m', type: FLT },
      { column: 'ALTITUDE_M', path: 'altitude_m', type: FLT },
      { column: 'ALTITUDE_ACCURACY_M', path: 'altitude_accuracy_m', type: FLT },
      { column: 'POSITION_PROVIDER', path: 'position_provider', type: STR },
      { column: 'POSITION_SOURCE', path: 'position_source', type: STR },
      { column: 'FIX_COUNT', path: 'fix_count', type: NUM },
      { column: 'FIX_SPREAD_M', path: 'fix_spread_m', type: FLT },
      { column: 'DEVIATION_REASON_CODE', path: 'deviation_reason_code', type: STR },
      { column: 'CAPTURED_TS_DEVICE', path: 'captured_ts_device', type: TS },
      { column: 'CAPTURED_TS_UTC_OFFSET', path: 'captured_ts_utc_offset', type: NUM },
      { column: 'DEVICE_UPTIME_MS', path: 'device_uptime_ms', type: NUM },
      { column: 'SAMPLER_PERSON_ID', path: 'sampler_person_id', type: STR },
      { column: 'DEVICE_ID', path: 'device_id', type: STR },
      { column: 'PERIOD_CODE', path: 'period_code', type: STR },
      { column: 'SPEC_ID', path: 'spec_id', type: STR },
      { column: 'PROTOCOL_VERSION', path: 'protocol_version', type: STR },
      { column: 'DEPTH_ACHIEVED_CM', path: 'depth_achieved_cm', type: FLT },
      { column: 'REFUSAL_CODE', path: 'refusal_code', type: STR },
      { column: 'CORES_TAKEN', path: 'cores_taken', type: NUM },
      { column: 'BD_CORE_TAKEN', path: 'bd_core_taken', type: BOOL },
      { column: 'NOTE', path: 'note', type: STR },
      { column: 'SUPERSEDES_SAMPLE_UID', path: 'supersedes_sample_uid', type: STR },
    ],
    matchedGuard: `COALESCE(t.REVIEW_STATE, 'captured') <> 'accepted'`,
  },
  sample_bag: {
    table: 'CURATED.SAMPLE_BAG',
    key: 'BAG_ID',
    columns: [
      { column: 'BAG_ID', path: 'bag_id', type: STR },
      { column: 'SAMPLE_UID', path: 'sample_uid', type: STR },
      { column: 'BAG_SEQ', path: 'bag_seq', type: NUM },
      { column: 'BAG_ROLE', path: 'bag_role', type: STR },
      { column: 'DEPTH_TOP_CM', path: 'depth_top_cm', type: FLT },
      { column: 'DEPTH_BOTTOM_CM', path: 'depth_bottom_cm', type: FLT },
      { column: 'LAB_ID', path: 'lab_id', type: STR },
      // VERBATIM. BARCODE_NORM is a derived column, rebuilt downstream, and
      // the raw value is never normalised in place.
      { column: 'BARCODE_RAW', path: 'barcode_raw', type: STR },
      { column: 'BARCODE_SYMBOLOGY', path: 'barcode_symbology', type: STR },
      { column: 'BARCODE_CAPTURE_METHOD', path: 'barcode_capture_method', type: STR },
      { column: 'BARCODE_SCANNED_TS', path: 'barcode_scanned_ts', type: TS },
      { column: 'VOID_FLAG', path: 'void_flag', type: BOOL },
      { column: 'VOID_REASON_CODE', path: 'void_reason_code', type: STR },
    ],
  },
  sample_condition: {
    table: 'CURATED.SAMPLE_CONDITION',
    key: 'CONDITION_ID',
    columns: [
      { column: 'CONDITION_ID', path: 'condition_id', type: STR },
      { column: 'SAMPLE_UID', path: 'sample_uid', type: STR },
      { column: 'CONDITION_CODE', path: 'condition_code', type: STR },
      { column: 'CONDITION_VALUE', path: 'condition_value', type: STR },
      { column: 'CODE_SET_VERSION', path: 'code_set_version', type: STR },
    ],
  },
  media_meta: {
    table: 'CURATED.MEDIA',
    key: 'MEDIA_ID',
    columns: [
      { column: 'MEDIA_ID', path: 'media_id', type: STR },
      { column: 'CONTENT_HASH', path: 'content_hash', type: STR },
      { column: 'SAMPLE_UID', path: 'sample_uid', type: STR },
      { column: 'BAG_ID', path: 'bag_id', type: STR },
      { column: 'VISIT_ID', path: 'visit_id', type: STR },
      { column: 'MEDIA_ROLE', path: 'media_role', type: STR },
      { column: 'IS_REQUIRED_ROLE', path: 'is_required_role', type: BOOL },
      { column: 'CAPTURE_ORDER', path: 'capture_order', type: NUM },
      { column: 'CAPTURE_TS_DEVICE', path: 'capture_ts_device', type: TS },
      { column: 'EXIF_LAT', path: 'exif_lat', type: FLT },
      { column: 'EXIF_LON', path: 'exif_lon', type: FLT },
      { column: 'EXIF_TS', path: 'exif_ts', type: TS },
      { column: 'EXIF_GPS_PRESENT', path: 'exif_gps_present', type: BOOL },
      { column: 'BYTES', path: 'bytes', type: NUM },
      { column: 'WIDTH_PX', path: 'width_px', type: NUM },
      { column: 'HEIGHT_PX', path: 'height_px', type: NUM },
      { column: 'MIME_TYPE', path: 'mime_type', type: STR },
      { column: 'CAPTURE_SOURCE', path: 'capture_source', type: STR },
      { column: 'DEVICE_ID', path: 'device_id', type: STR },
    ],
  },
  local_defect: {
    table: 'CURATED.SAMPLE_DEFECT',
    key: 'DEFECT_ID',
    columns: [
      { column: 'DEFECT_ID', path: 'defect_id', type: STR },
      { column: 'SAMPLE_UID', path: 'sample_uid', type: STR },
      { column: 'BAG_ID', path: 'bag_id', type: STR },
      { column: 'VISIT_ID', path: 'visit_id', type: STR },
      { column: 'PLAN_POINT_ID', path: 'plan_point_id', type: STR },
      { column: 'DEFECT_CODE', path: 'defect_code', type: STR },
      { column: 'SEVERITY', path: 'severity', type: STR },
      { column: 'DETECTED_TS', path: 'detected_ts', type: TS },
      { column: 'DETAIL', path: 'detail', type: STR },
    ],
  },
};

/** `EXIF_RAW` is VARIANT — it is preserved whole, not cast to a scalar. */
const VARIANT_COLUMNS: Partial<Record<SyncEntityType, Array<{ column: string; path: string }>>> = {
  media_meta: [{ column: 'EXIF_RAW', path: 'exif_raw' }],
};

export function isMergeableEntity(t: SyncEntityType): t is keyof typeof MAPPINGS {
  return t in MAPPINGS;
}

export function mergeableEntityTypes(): Array<keyof typeof MAPPINGS> {
  return Object.keys(MAPPINGS) as Array<keyof typeof MAPPINGS>;
}

/**
 * Builds the MERGE for one entity type.
 *
 * @param sourceExpr a VARIANT expression yielding an ARRAY of payload objects —
 *   `PARSE_JSON(?)` from the live path, a select over RAW on the rebuild path.
 * @param batchIdExpr expression yielding the batch id to stamp on each row.
 */
export function curatedMergeSql(
  entityType: keyof typeof MAPPINGS,
  sourceExpr: string,
  batchIdExpr: string,
): string {
  const m = MAPPINGS[entityType];
  const variants = VARIANT_COLUMNS[entityType] ?? [];

  const projections = [
    ...m.columns.map((c) => `v.value:${c.path}::${c.type} AS ${c.column}`),
    ...variants.map((c) => `v.value:${c.path} AS ${c.column}`),
  ];

  const dataColumns = [...m.columns.map((c) => c.column), ...variants.map((c) => c.column)];
  const stamped = [...dataColumns, 'SYNC_BATCH_ID'];

  const updates = dataColumns
    .filter((c) => c !== m.key)
    .map((c) => `${c} = s.${c}`)
    .concat([
      'SYNC_BATCH_ID = s.SYNC_BATCH_ID',
      'LAST_UPDATED_TS = CURRENT_TIMESTAMP()',
      'LAST_UPDATED_BY = CURRENT_USER()',
    ]);

  const matched = m.matchedGuard
    ? `WHEN MATCHED AND ${m.matchedGuard} THEN UPDATE SET`
    : 'WHEN MATCHED THEN UPDATE SET';

  return `MERGE INTO ${m.table} t
USING (
  SELECT ${projections.join(',\n         ')},
         ${batchIdExpr} AS SYNC_BATCH_ID
    FROM TABLE(FLATTEN(input => ${sourceExpr})) v
) s
   ON t.${m.key} = s.${m.key}
 ${matched}
      ${updates.join(',\n      ')}
 WHEN NOT MATCHED THEN
      INSERT (${stamped.join(', ')})
      VALUES (${stamped.map((c) => `s.${c}`).join(', ')})`;
}

/** The entity's Snowflake table, for callers that need to name it. */
export function tableFor(entityType: keyof typeof MAPPINGS): string {
  return MAPPINGS[entityType].table;
}
