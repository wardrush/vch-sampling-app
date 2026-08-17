/**
 * Postgres statement text for `/ingest/commit`, alongside the Snowflake
 * originals in `index.ts` — which are byte-for-byte unchanged, per the agent
 * file's "extend around it, do not rewrite" instruction.
 *
 * **Every dialect gap here is one of the four named in the wave prompt:**
 * `MERGE INTO … USING` → `INSERT … ON CONFLICT`, `PARSE_JSON`/`VARIANT` →
 * `::jsonb`, `TABLE(FLATTEN(…))` → `jsonb_array_elements`, `CURRENT_TIMESTAMP()`
 * → `CURRENT_TIMESTAMP` (Postgres rejects the parens). Nothing here calls
 * `ST_*` — confirmed by reading every statement; there was never a geospatial
 * call in this file to begin with (`PLANNED_GEOG` was Snowflake-only, and it
 * is simply not written on Postgres — `postgres_sampling_v01.sql`'s
 * `SAMPLE_PLAN_POINT` has no `PLANNED_GEOG` column: "no PostGIS. PLANNED_LAT/LON
 * are the whole input to the deferred offset computation").
 *
 * **Every unique constraint used in an `ON CONFLICT` clause below matches
 * `schema-steward`'s per-table list** (wave report §2) — I did not add or
 * choose one; I read it off `postgres_sampling_v01.sql`.
 *
 * **Placeholder count and order matter, and `index.ts` builds a separate
 * bind array per statement** rather than one global flat array shared between
 * dialects — so a Postgres statement is free to have a different placeholder
 * count than its Snowflake counterpart (see `RAW_FILE_SQL`, which needs none
 * of this and is reused unchanged for both dialects) as long as the binds
 * passed alongside a given SQL string are in the same left-to-right order the
 * `?`s appear in that string.
 */

/** ON CONFLICT (IMPORT_ID). 15 binds, same order as the Snowflake statement. */
export const PG_PLAN_IMPORT_SQL = `INSERT INTO CURATED.PLAN_IMPORT
  (IMPORT_ID, CONTENT_HASH, IMPORTED_BY, IMPORTED_TS, SOURCE_KIND,
   ORIGINAL_FILENAME, MAPPING_JSON, PERIOD_CODE, PROJECT_ID, ROW_COUNT,
   ROWS_COMMITTED, ROWS_FLAGGED, ROWS_BLOCKED, PLAN_IDS, STATUS)
VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?, ?::jsonb, ?)
ON CONFLICT (IMPORT_ID) DO UPDATE SET
  ROWS_COMMITTED = EXCLUDED.ROWS_COMMITTED,
  ROWS_FLAGGED = EXCLUDED.ROWS_FLAGGED,
  ROWS_BLOCKED = EXCLUDED.ROWS_BLOCKED,
  PLAN_IDS = EXCLUDED.PLAN_IDS,
  STATUS = EXCLUDED.STATUS,
  LAST_UPDATED_TS = CURRENT_TIMESTAMP`;

/**
 * ON CONFLICT (IMPORT_ROW_ID). 1 bind — the whole rows array, same as the
 * Snowflake statement's single `PARSE_JSON(?)`.
 *
 * Writes BOTH `RAW_VALUES_TEXT` (verbatim, the reproducibility anchor —
 * `RAW_VALUES_JSON` alone loses spreadsheet column order the same way
 * Snowflake's `VARIANT` does) and `RAW_VALUES_JSON` (the queryable jsonb
 * projection of the same string), per the wave report §4.
 */
export const PG_PLAN_IMPORT_ROW_SQL = `INSERT INTO CURATED.PLAN_IMPORT_ROW
  (IMPORT_ROW_ID, IMPORT_ID, SOURCE_ROW_NO, RAW_VALUES_TEXT, RAW_VALUES_JSON,
   PLAN_POINT_LABEL, LAT_RAW, LON_RAW, LAT, LON, COORD_FORMAT_DETECTED,
   COORD_FIX_APPLIED, BOUNDARY_ID_STATED, BOUNDARY_ID_RESOLVED, FIELD_NAME,
   STRATA_LABEL, ELEVATION_CLASS, SEQUENCE_NO, ACCESS_NOTE, PRIOR_SAMPLE_UID,
   EXTRA_JSON, OPERATION_TEXT, OPERATION_MATCH_ID, OPERATION_MATCH_SCORE,
   OPERATION_MATCH_STATUS, CONTACT_NAME_TEXT, CONTACT_PHONE_TEXT,
   CONTACT_EMAIL_TEXT, CONTACT_MATCH_ID, CONTACT_MATCH_SCORE,
   CONTACT_MATCH_STATUS, ROW_STATUS, VALIDATION_CODES)
SELECT
  elem->>'import_row_id', elem->>'import_id', (elem->>'source_row_no')::numeric,
  elem->>'raw_values_json', (elem->>'raw_values_json')::jsonb,
  elem->>'plan_point_label', elem->>'lat_raw', elem->>'lon_raw',
  (elem->>'lat')::numeric, (elem->>'lon')::numeric,
  elem->>'coord_format_detected', elem->>'coord_fix_applied',
  elem->>'boundary_id_stated', elem->>'boundary_id_resolved', elem->>'field_name',
  elem->>'strata_label', elem->>'elevation_class', (elem->>'sequence_no')::numeric,
  elem->>'access_note', elem->>'prior_sample_uid', (elem->>'extra_json')::jsonb,
  elem->>'operation_text', elem->>'operation_match_id',
  (elem->>'operation_match_score')::numeric, elem->>'operation_match_status',
  elem->>'contact_name_text', elem->>'contact_phone_text', elem->>'contact_email_text',
  elem->>'contact_match_id', (elem->>'contact_match_score')::numeric,
  elem->>'contact_match_status', elem->>'row_status', elem->'validation_codes'
  FROM jsonb_array_elements(?::jsonb) AS elem
ON CONFLICT (IMPORT_ROW_ID) DO UPDATE SET
  ROW_STATUS = EXCLUDED.ROW_STATUS,
  VALIDATION_CODES = EXCLUDED.VALIDATION_CODES,
  BOUNDARY_ID_RESOLVED = EXCLUDED.BOUNDARY_ID_RESOLVED,
  LAST_UPDATED_TS = CURRENT_TIMESTAMP`;

/** 1 bind — the array of superseded parent plan ids. */
export const PG_SUPERSEDE_PLANS_SQL = `UPDATE CURATED.SAMPLE_PLAN
   SET STATUS = 'superseded', LAST_UPDATED_TS = CURRENT_TIMESTAMP
 WHERE PLAN_ID IN (SELECT jsonb_array_elements_text(?::jsonb))`;

/**
 * ON CONFLICT (PLAN_ID). 3 binds, IN TEXT ORDER: released_ts, released_by,
 * then the plans array — this is a *different order* than the Snowflake
 * statement's binds (array first), which is fine because `index.ts` gives
 * this statement its own bind array rather than sharing one flat array
 * across dialects (see the file header).
 */
export const PG_SAMPLE_PLAN_SQL = `INSERT INTO CURATED.SAMPLE_PLAN
  (PLAN_ID, BOUNDARY_ID, SPEC_ID, PERIOD_CODE, PLAN_VERSION, PARENT_PLAN_ID,
   STATUS, POINT_COUNT, GENERATION_METHOD, RELEASED_TS, RELEASED_BY, IMPORT_ID)
SELECT
  elem->>'plan_id', elem->>'boundary_id', '', elem->>'period_code',
  (elem->>'plan_version')::numeric, elem->>'parent_plan_id', 'released',
  (elem->>'point_count')::numeric, 'plan_import', ?, ?, elem->>'import_id'
  FROM jsonb_array_elements(?::jsonb) AS elem
ON CONFLICT (PLAN_ID) DO UPDATE SET
  POINT_COUNT = EXCLUDED.POINT_COUNT,
  LAST_UPDATED_TS = CURRENT_TIMESTAMP`;

/**
 * ON CONFLICT (PLAN_POINT_ID). 1 bind. No `PLANNED_GEOG` — the Postgres
 * `SAMPLE_PLAN_POINT` table does not have the column (no PostGIS); lifting the
 * geospatial deferral later is a code change here, not a migration, per the
 * DDL's own comment.
 */
export const PG_SAMPLE_PLAN_POINT_SQL = `INSERT INTO CURATED.SAMPLE_PLAN_POINT
  (PLAN_POINT_ID, PLAN_ID, PLAN_POINT_LABEL, PLANNED_LAT, PLANNED_LON,
   STRATA_LABEL, ELEVATION_CLASS, PRIOR_SAMPLE_UID, SEQUENCE_NO, ACCESS_NOTE,
   IMPORT_ROW_ID)
SELECT
  elem->>'plan_point_id', elem->>'plan_id', elem->>'plan_point_label',
  (elem->>'planned_lat')::numeric, (elem->>'planned_lon')::numeric,
  elem->>'strata_label', elem->>'elevation_class', elem->>'prior_sample_uid',
  (elem->>'sequence_no')::numeric, elem->>'access_note', elem->>'import_row_id'
  FROM jsonb_array_elements(?::jsonb) AS elem
ON CONFLICT (PLAN_POINT_ID) DO UPDATE SET
  PLANNED_LAT = EXCLUDED.PLANNED_LAT,
  PLANNED_LON = EXCLUDED.PLANNED_LON,
  LAST_UPDATED_TS = CURRENT_TIMESTAMP`;

/**
 * Same `UPDATE … FROM …` shape as the Snowflake statement — that part is
 * already standard SQL and portable. Only `CURRENT_TIMESTAMP()` needed the
 * parens dropped. 1 bind.
 */
export const PG_STAMP_ROW_POINTS_SQL = `UPDATE CURATED.PLAN_IMPORT_ROW r
   SET PLAN_POINT_ID = pp.PLAN_POINT_ID,
       ROW_STATUS = 'committed',
       LAST_UPDATED_TS = CURRENT_TIMESTAMP
  FROM CURATED.SAMPLE_PLAN_POINT pp
 WHERE pp.IMPORT_ROW_ID = r.IMPORT_ROW_ID
   AND r.IMPORT_ID = ?`;

/**
 * ON CONFLICT (DEFECT_ID). The `WHEN MATCHED AND t.RESOLUTION_STATE = 'open'`
 * guard becomes a `WHERE` on the `DO UPDATE` — schema-steward's report is
 * explicit that every `MERGE`'s `WHEN MATCHED AND <guard>` becomes exactly
 * this. 1 bind.
 */
export const PG_QUEUE_ITEMS_SQL = `INSERT INTO CURATED.SAMPLE_DEFECT AS t
  (DEFECT_ID, PLAN_POINT_ID, DEFECT_CODE, SEVERITY, DETECTED_BY, DETECTED_TS,
   DETAIL, RESOLUTION_STATE, VISIBLE_TO_FIELD)
SELECT
  elem->>'defect_id', elem->>'plan_point_id', elem->>'defect_code', elem->>'severity',
  'server_rule', CURRENT_TIMESTAMP, elem->>'detail', 'open', FALSE
  FROM jsonb_array_elements(?::jsonb) AS elem
ON CONFLICT (DEFECT_ID) DO UPDATE SET
  DETAIL = EXCLUDED.DETAIL,
  LAST_UPDATED_TS = CURRENT_TIMESTAMP
WHERE t.RESOLUTION_STATE = 'open'`;

/** Plain INSERT, no conflict target needed (schema-steward's list). 11 binds, same order. */
export const PG_AUDIT_SQL = `INSERT INTO CURATED.AUDIT_EVENT
  (EVENT_ID, EVENT_TS, ACTOR_REF, ACTOR_KIND, SURFACE, ACTION, ENTITY_TYPE,
   ENTITY_ID, DETAIL_JSON, IP_HASH, USER_AGENT_RAW)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?`;

/**
 * `loadPriorPlans`'s `QUALIFY` rewritten as a window function in a subquery —
 * the one `QUALIFY` in this file, per the wave report. Same 1 + N binds
 * (period code, then boundary ids) in the same order as the Snowflake version.
 */
export function pgLoadPriorPlansSql(boundaryPlaceholders: string): string {
  return `SELECT BOUNDARY_ID, PLAN_ID, PLAN_VERSION FROM (
    SELECT BOUNDARY_ID, PLAN_ID, PLAN_VERSION,
           ROW_NUMBER() OVER (PARTITION BY BOUNDARY_ID ORDER BY PLAN_VERSION DESC) AS RN
      FROM CURATED.SAMPLE_PLAN
     WHERE PERIOD_CODE = ? AND STATUS <> 'superseded'
       AND BOUNDARY_ID IN (${boundaryPlaceholders})
  ) s WHERE RN = 1`;
}
