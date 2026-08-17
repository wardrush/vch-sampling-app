/**
 * Parse + upsert into CURATED, on the client keys. Contract §6 step 2.
 *
 * **The projection below is the parse, and it is deliberately the only one.**
 * `curatedMergeSql()` takes the *source expression* as a parameter, so the
 * same SQL serves both callers:
 *
 *   - `/sync/batch` passes `PARSE_JSON(?)` / `(?)::jsonb` — the batch just received.
 *   - the rebuild path passes a select over `RAW.SYNC_PAYLOAD`.
 *
 * That is what makes v02 §11 criterion 5 — *`CURATED` dropped and rebuilt
 * entirely from `RAW`* — a property of the code rather than an aspiration. Two
 * parsers would make it a lie within a season, and step 1 of the pipeline
 * exists precisely to keep it true.
 *
 * The name still says "merge" because that is the *operation*: match on the
 * client key, update or insert, never duplicate. It is a `MERGE INTO` on
 * Snowflake and an `INSERT … ON CONFLICT (pk) DO UPDATE` on Postgres, which has
 * no `MERGE` here (`capabilities.mergeInto === false`). The two forms are
 * generated from one column mapping, so a column added to a payload cannot
 * reach one backend and miss the other.
 *
 * Nothing derived appears here. `GEOG`, `BOUNDARY_ID`, `TRS_CANONICAL`,
 * `OFFSET_FROM_PLAN_M` and `BEARING_FROM_PLAN_DEG` are computed in one place
 * downstream (contract §6 steps 3–6). The device's own offset figure is
 * advisory and is not stored — it never reaches a column.
 *
 * ## Placeholder order is part of the contract
 *
 * The generated SQL mentions `batchIdExpr` **before** `sourceExpr`, because a
 * projection precedes its `FROM`. Binds are positional on both backends, so a
 * caller must bind the batch id first and the payload second. Getting that
 * backwards puts a JSON array in `SYNC_BATCH_ID` and a batch id through
 * `PARSE_JSON` — which is exactly the bug this file shipped with, invisible
 * because no test asserted bind order and no live warehouse ever ran it. Use
 * `curatedWriteForPayload()` and you cannot get it wrong.
 */

import type { SyncEntityType } from '../../shared/contract/common.js';
import type { BindValue, SqlDialect } from '../../shared/db/port.js';
import { type JsonScalarType, syntaxFor } from './dialect.js';

interface ColumnSpec {
  /** Curated column, same name on both backends. */
  column: string;
  /** Key in the record payload. */
  path: string;
  /** Cast applied to the extracted JSON scalar. */
  type: JsonScalarType;
}

interface EntityMapping {
  table: string;
  key: string;
  columns: ColumnSpec[];
  /**
   * Extra `WHEN MATCHED` / `DO UPDATE … WHERE` guard, written against the
   * target alias `t`. Contract §1 property 5 — the server refuses to mutate a
   * record already accepted. A replay of an accepted record is not an error, it
   * simply changes nothing, which is what makes a re-POST return the same
   * acknowledgement.
   */
  matchedGuard?: string;
  /**
   * `false` for a table with no `LAST_UPDATED_TS` / `LAST_UPDATED_BY`.
   *
   * `CURATED.SAMPLE_CONDITION` has neither, in **both** DDL files — conditions
   * are append-only facts about a sample. Stamping them unconditionally made
   * every `sample_condition` write fail with an invalid-identifier error on
   * Snowflake too; it was invisible because the tests assert on generated SQL
   * and nothing had ever run against a database.
   */
  auditStamped?: boolean;
  /**
   * `false` for a table with no `SYNC_BATCH_ID` column.
   *
   * `CURATED.SAMPLE_DEFECT` has none, in **either** DDL file — a defect's
   * provenance is `DETECTED_BY` plus its subject, and the server-rule writers
   * (`raiseDefectFromQuery`, the A7 harness) never set it either. Stamping it
   * from the `local_defect` mapping was the same class of invalid-identifier
   * error, on both backends.
   *
   * If batch provenance on device-raised defects is wanted, the column is a
   * one-line addition to both DDL files and this flag comes off — that is a
   * schema decision and it belongs to `schema-steward`. Recorded in
   * `integration/requests-a.md`.
   */
  batchStamped?: boolean;
}

const TS = 'timestamp';
const STR = 'text';
const NUM = 'number';
const FLT = 'float';
const BOOL = 'boolean';

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
      { column: 'VISIT_DATE', path: 'visit_date', type: 'date' },
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
    // No LAST_UPDATED_TS / LAST_UPDATED_BY on this table, in either DDL.
    auditStamped: false,
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
    // No SYNC_BATCH_ID on CURATED.SAMPLE_DEFECT, in either DDL.
    batchStamped: false,
  },
};

/** `EXIF_RAW` is a JSON document — preserved whole, not cast to a scalar. */
const VARIANT_COLUMNS: Partial<Record<SyncEntityType, Array<{ column: string; path: string }>>> = {
  media_meta: [{ column: 'EXIF_RAW', path: 'exif_raw' }],
};

export type MergeableEntityType = keyof typeof MAPPINGS;

export function isMergeableEntity(t: SyncEntityType): t is MergeableEntityType {
  return t in MAPPINGS;
}

export function mergeableEntityTypes(): MergeableEntityType[] {
  return Object.keys(MAPPINGS) as MergeableEntityType[];
}

/** The entity's curated table, for callers that need to name it. */
export function tableFor(entityType: MergeableEntityType): string {
  return MAPPINGS[entityType].table;
}

/** The entity's client key column. */
export function keyColumnFor(entityType: MergeableEntityType): string {
  return MAPPINGS[entityType].key;
}

/** The payload field carrying the client key — the rebuild path de-duplicates on it. */
export function keyPathFor(entityType: MergeableEntityType): string {
  const m = MAPPINGS[entityType];
  const spec = m.columns.find((c) => c.column === m.key);
  if (!spec) throw new Error(`mapping for ${entityType} has no column for its key ${m.key}`);
  return spec.path;
}

/** Every curated column this mapping writes — used by the DDL parity test. */
export function columnsFor(entityType: MergeableEntityType): string[] {
  const m = MAPPINGS[entityType];
  return [
    ...m.columns.map((c) => c.column),
    ...(VARIANT_COLUMNS[entityType] ?? []).map((c) => c.column),
    ...(m.batchStamped === false ? [] : ['SYNC_BATCH_ID']),
    ...(m.auditStamped === false ? [] : ['LAST_UPDATED_TS', 'LAST_UPDATED_BY']),
  ];
}

/**
 * Builds the upsert for one entity type.
 *
 * @param sourceExpr a JSON expression yielding an **array of payload objects** —
 *   `PARSE_JSON(?)` / `(?)::jsonb` from the live path, a select over RAW on the
 *   rebuild path.
 * @param batchIdExpr expression yielding the batch id to stamp on each row.
 * @param dialect defaults to `snowflake`, which keeps every pre-existing caller
 *   and the Snowflake output byte-identical to before the Postgres port.
 */
export function curatedMergeSql(
  entityType: MergeableEntityType,
  sourceExpr: string,
  batchIdExpr: string,
  dialect: SqlDialect = 'snowflake',
): string {
  const syntax = syntaxFor(dialect);
  const m = MAPPINGS[entityType];
  const variants = VARIANT_COLUMNS[entityType] ?? [];

  const projections = [
    ...m.columns.map((c) => `${syntax.jsonScalar('v.value', c.path, c.type)} AS ${c.column}`),
    ...variants.map((c) => `${syntax.jsonSubtree('v.value', c.path)} AS ${c.column}`),
  ];

  const dataColumns = [...m.columns.map((c) => c.column), ...variants.map((c) => c.column)];
  // The projection always carries SYNC_BATCH_ID, even where the target table
  // has no such column: it keeps `batchIdExpr`'s placeholder in the statement,
  // so bind order and bind count are the same for every entity type and a
  // caller cannot get them right for five mappings and wrong for the sixth.
  const stamped = m.batchStamped === false ? dataColumns : [...dataColumns, 'SYNC_BATCH_ID'];
  const batchStamp = m.batchStamped === false ? [] : ['SYNC_BATCH_ID'];
  const auditStamps =
    m.auditStamped === false
      ? []
      : [`LAST_UPDATED_TS = ${syntax.now}`, `LAST_UPDATED_BY = ${syntax.currentUser}`];

  if (dialect === 'postgres') {
    // INSERT … ON CONFLICT. The subquery keeps ONE occurrence per client key:
    // `ON CONFLICT DO UPDATE` refuses to touch the same row twice in one
    // statement, and a poisoned batch that can never succeed is worse than a
    // last-writer-wins pick. `ORDER BY … DESC` makes "last in the array" win,
    // which is the same precedence the outbox applies when a sampler corrects a
    // record before it syncs.
    const updates = dataColumns
      .filter((c) => c !== m.key)
      .map((c) => `${c} = EXCLUDED.${c}`)
      .concat(
        batchStamp.map((c) => `${c} = EXCLUDED.${c}`),
        auditStamps,
      );

    const guard = m.matchedGuard ? `\n     WHERE ${m.matchedGuard}` : '';

    return `INSERT INTO ${m.table} AS t
       (${stamped.join(', ')})
SELECT ${stamped.join(', ')}
  FROM (
  SELECT ${projections.join(',\n         ')},
         ${batchIdExpr} AS SYNC_BATCH_ID,
         ROW_NUMBER() OVER (
           PARTITION BY ${syntax.jsonScalar('v.value', keyPathFor(entityType), 'text')}
               ORDER BY ${syntax.ordinal('v')} DESC) AS DEDUPE_RN
    FROM ${syntax.jsonArrayRows(sourceExpr, 'v')}
) s
 WHERE s.DEDUPE_RN = 1
    ON CONFLICT (${m.key}) DO UPDATE SET
       ${updates.join(',\n       ')}${guard}`;
  }

  const updates = dataColumns
    .filter((c) => c !== m.key)
    .map((c) => `${c} = s.${c}`)
    .concat(
      batchStamp.map((c) => `${c} = s.${c}`),
      auditStamps,
    );

  const matched = m.matchedGuard
    ? `WHEN MATCHED AND ${m.matchedGuard} THEN UPDATE SET`
    : 'WHEN MATCHED THEN UPDATE SET';

  return `MERGE INTO ${m.table} t
USING (
  SELECT ${projections.join(',\n         ')},
         ${batchIdExpr} AS SYNC_BATCH_ID
    FROM ${syntax.jsonArrayRows(sourceExpr, 'v')}
) s
   ON t.${m.key} = s.${m.key}
 ${matched}
      ${updates.join(',\n      ')}
 WHEN NOT MATCHED THEN
      INSERT (${stamped.join(', ')})
      VALUES (${stamped.map((c) => `s.${c}`).join(', ')})`;
}

export interface CuratedWrite {
  sql: string;
  /** Positional, in the order the generated SQL mentions its placeholders. */
  binds: BindValue[];
}

/**
 * The live `/sync/batch` write: SQL and binds together, so the order cannot be
 * transposed by a caller.
 *
 * @param payloadsJson `JSON.stringify` of the array of record payloads.
 */
export function curatedWriteForPayload(
  entityType: MergeableEntityType,
  payloadsJson: string,
  syncBatchId: string,
  dialect: SqlDialect,
): CuratedWrite {
  const syntax = syntaxFor(dialect);
  return {
    sql: curatedMergeSql(entityType, syntax.parseJson('?'), '?', dialect),
    // Batch id first: the projection that stamps it precedes the FROM that
    // parses the payload. See the header note.
    binds: [syncBatchId, payloadsJson],
  };
}
