/**
 * C11 — `POST /ingest/commit`. Spec §7, addendum §4.3.
 *
 * The one Lane C task where subtly wrong is expensive: an ordered multi-table
 * write with double-click safety and the upsert-never-delete discipline.
 *
 * Order, and why each step is where it is:
 *
 *   1. **`RAW.PLAN_IMPORT_FILE` — the bytes, verbatim, content-hashed.** For a
 *      paste, the pasted text *is* the artefact. Same discipline as raw lab
 *      files and raw sync payloads, and the reason an import is reproducible.
 *   2. **`PLAN_IMPORT`** with the resolved mapping, so the import can be
 *      replayed from its raw file.
 *   3. **`PLAN_IMPORT_ROW` for every input row, including the blocked ones.**
 *      The rejected rows are part of the record; an import that silently
 *      dropped five rows is an import nobody can audit.
 *   4. **`SAMPLE_PLAN` / `SAMPLE_PLAN_POINT`** for the committed rows, grouped
 *      by boundary, as a new plan version superseding the previous one.
 *   5. **Analyst-queue items** for unresolved operations and contacts.
 *   6. **`AUDIT_EVENT`** — inside the same transaction, because spec §7 makes
 *      the audit row part of the commit rather than a note about it.
 *
 * **An upload never creates CRM records** (D16). Operation and contact strings
 * land as text with a match status; where the match is unresolved this raises a
 * queue item and stops. There is no code path here that writes an `OPERATION`
 * or a `PERSON`, and adding one is a schema decision, not a convenience.
 *
 * Steps 2–6 go to Snowflake as one multi-statement request, which Snowflake
 * runs in a single transaction. Combined with the deterministic ids in
 * `ids.ts`, a retry of a partially-applied commit converges rather than
 * duplicating.
 */

import type {
  IngestCommitRequest,
  IngestCommitResponse,
  ParsedPlanRow,
  ValidatedPlanRow,
} from '../../shared/contract/ingest.js';
import { DEFECT_CODE, AUDIT_ACTION } from '../../shared/codes/index.js';
import type { SnowflakeClient } from '../../shared/snowflake/client.js';
import { asObjects } from '../../shared/snowflake/client.js';
import { type BlobStore, importFileKey } from '../../server/storage/blobs.js';
import { hashIp } from '../../shared/auth/audit.js';
import { canonicalMapping, importId, importRowId, planId, planPointId, queueDefectId } from './ids.js';
import { uuidv7 } from 'uuidv7';

export interface CommitActor {
  /** `person_ref` from the session. Stamped as `IMPORTED_BY`. */
  ref: string;
  kind: 'token' | 'idp_user' | 'service';
  ip?: string | null;
  user_agent?: string | null;
}

export interface CommitDeps {
  snowflake: SnowflakeClient;
  blobs: BlobStore;
  actor: CommitActor;
  ipHashSalt: string;
  now?: () => number;
}

export async function commitImport(
  request: IngestCommitRequest,
  deps: CommitDeps,
): Promise<IngestCommitResponse> {
  const now = deps.now ?? Date.now;
  const importedTs = new Date(now()).toISOString();
  const contentHash = request.raw_file.content_hash;
  const id = importId(contentHash, deps.actor.ref, request.mapping);

  const validatedByRow = new Map(request.validated.map((v) => [v.source_row_no, v]));
  const rows = request.rows.map((row) => buildRow(id, row, validatedByRow.get(row.source_row_no)));

  const committable = rows.filter((r) => r.row_status !== 'blocked' && r.boundary_id_resolved);
  const blockedCount = rows.filter((r) => r.row_status === 'blocked').length;
  const flaggedCount = rows.filter((r) => r.row_status === 'flagged').length;

  // ---- 0. Replay ----------------------------------------------------------
  // Deterministic ids mean the writes below would be no-ops anyway; this saves
  // the round trips and returns the original answer rather than a rebuilt one.
  const existing = await findExistingImport(deps.snowflake, id);
  if (existing && existing.status !== 'staged') {
    return {
      import_id: id,
      content_hash: contentHash,
      idempotent_replay: true,
      status: existing.status === 'retired' ? 'blocked' : 'committed',
      plan_ids: existing.plan_ids,
      row_count: rows.length,
      rows_committed: Number(existing.rows_committed ?? 0),
      rows_flagged: flaggedCount,
      rows_blocked: blockedCount,
      queue_items: 0,
      imported_ts: existing.imported_ts ?? importedTs,
    };
  }

  // ---- 1. RAW bytes, verbatim ---------------------------------------------
  const bytes = rawBytes(request);
  await deps.blobs.put(importFileKey(contentHash), bytes, {
    imported_by: deps.actor.ref,
    source_kind: request.raw_file.source_kind,
  });

  // A plan version is a function of what is already released for the boundary
  // and period, so it has to be read before the write is composed.
  const boundaries = [...new Set(committable.map((r) => r.boundary_id_resolved!))];
  const priorPlans = await loadPriorPlans(
    deps.snowflake,
    boundaries,
    request.period_code,
  );

  const plans = boundaries.map((boundaryId) => {
    const prior = priorPlans.get(boundaryId);
    return {
      plan_id: planId(id, boundaryId, request.period_code),
      boundary_id: boundaryId,
      period_code: request.period_code,
      plan_version: (prior?.plan_version ?? 0) + 1,
      parent_plan_id: prior?.plan_id ?? null,
      point_count: committable.filter((r) => r.boundary_id_resolved === boundaryId).length,
      import_id: id,
    };
  });

  const points = committable.map((row) => ({
    plan_point_id: planPointId(row.import_row_id),
    plan_id: planId(id, row.boundary_id_resolved!, request.period_code),
    plan_point_label: row.plan_point_label,
    planned_lat: row.lat,
    planned_lon: row.lon,
    strata_label: row.strata_label,
    elevation_class: row.elevation_class,
    prior_sample_uid: row.prior_sample_uid,
    sequence_no: row.sequence_no,
    access_note: row.access_note,
    import_row_id: row.import_row_id,
  }));

  const queueItems = buildQueueItems(rows);

  // ---- 2–6. One transaction ----------------------------------------------
  const statements: string[] = [];
  const binds: Array<string | number | boolean | null> = [];

  statements.push(RAW_FILE_SQL);
  binds.push(
    contentHash,
    request.raw_file.original_filename ?? null,
    request.raw_file.mime_type ?? null,
    request.raw_file.bytes,
    request.raw_file.source_kind,
    importFileKey(contentHash),
    request.raw_file.raw_text ?? null,
    deps.actor.ref,
    importedTs,
    contentHash,
  );

  statements.push(PLAN_IMPORT_SQL);
  binds.push(
    id,
    contentHash,
    deps.actor.ref,
    importedTs,
    request.raw_file.source_kind,
    request.raw_file.original_filename ?? null,
    JSON.stringify(request.mapping),
    request.period_code,
    request.project_id ?? null,
    rows.length,
    points.length,
    flaggedCount,
    blockedCount,
    JSON.stringify(plans.map((p) => p.plan_id)),
    points.length > 0 ? 'committed' : 'staged',
  );

  statements.push(PLAN_IMPORT_ROW_SQL);
  binds.push(JSON.stringify(rows));

  if (plans.length > 0) {
    // Supersede first, then insert: a boundary must never have two released
    // plans for one period, not even for the width of a statement.
    statements.push(SUPERSEDE_PLANS_SQL);
    binds.push(
      JSON.stringify(plans.map((p) => p.parent_plan_id).filter((x): x is string => !!x)),
    );

    statements.push(SAMPLE_PLAN_SQL);
    binds.push(JSON.stringify(plans), importedTs, deps.actor.ref);

    statements.push(SAMPLE_PLAN_POINT_SQL);
    binds.push(JSON.stringify(points));

    statements.push(STAMP_ROW_POINTS_SQL);
    binds.push(id);
  }

  if (queueItems.length > 0) {
    statements.push(QUEUE_ITEMS_SQL);
    binds.push(JSON.stringify(queueItems));
  }

  statements.push(AUDIT_SQL);
  binds.push(
    uuidv7(),
    importedTs,
    deps.actor.ref,
    deps.actor.kind,
    'ingest',
    AUDIT_ACTION.IMPORT_COMMIT,
    'plan_import',
    id,
    JSON.stringify({
      content_hash: contentHash,
      source_kind: request.raw_file.source_kind,
      original_filename: request.raw_file.original_filename,
      mapping: canonicalMapping(request.mapping),
      row_count: rows.length,
      rows_committed: points.length,
      rows_flagged: flaggedCount,
      rows_blocked: blockedCount,
      plan_ids: plans.map((p) => p.plan_id),
      sandbox: request.sandbox === true,
    }),
    hashIp(deps.actor.ip, deps.ipHashSalt),
    deps.actor.user_agent ?? null,
  );

  await deps.snowflake.executeMulti(statements, { binds });

  return {
    import_id: id,
    content_hash: contentHash,
    idempotent_replay: false,
    status: points.length > 0 ? 'committed' : 'blocked',
    plan_ids: plans.map((p) => p.plan_id),
    row_count: rows.length,
    rows_committed: points.length,
    rows_flagged: flaggedCount,
    rows_blocked: blockedCount,
    queue_items: queueItems.length,
    imported_ts: importedTs,
  };
}

interface CommitRow {
  import_row_id: string;
  import_id: string;
  source_row_no: number;
  raw_values_json: string;
  plan_point_label: string | null;
  lat_raw: string | null;
  lon_raw: string | null;
  lat: number | null;
  lon: number | null;
  coord_format_detected: string;
  coord_fix_applied: string | null;
  boundary_id_stated: string | null;
  boundary_id_resolved: string | null;
  field_name: string | null;
  strata_label: string | null;
  elevation_class: string | null;
  sequence_no: number | null;
  access_note: string | null;
  prior_sample_uid: string | null;
  extra_json: string;
  operation_text: string | null;
  operation_match_id: string | null;
  operation_match_score: number | null;
  operation_match_status: string | null;
  contact_name_text: string | null;
  contact_phone_text: string | null;
  contact_email_text: string | null;
  contact_match_id: string | null;
  contact_match_score: number | null;
  contact_match_status: string | null;
  row_status: string;
  validation_codes: string[];
}

function buildRow(
  id: string,
  row: ParsedPlanRow,
  validated: ValidatedPlanRow | undefined,
): CommitRow {
  return {
    import_row_id: importRowId(id, row.source_row_no),
    import_id: id,
    source_row_no: row.source_row_no,
    // Verbatim, pre-mapping. The reproducibility anchor for the row — and, per
    // addendum §5, the retention question nobody has answered yet.
    raw_values_json: JSON.stringify(row.raw_values),
    plan_point_label: row.plan_point_label,
    lat_raw: row.lat_raw,
    lon_raw: row.lon_raw,
    lat: row.lat,
    lon: row.lon,
    coord_format_detected: row.coord_format_detected,
    coord_fix_applied: row.coord_fix_applied,
    boundary_id_stated: row.boundary_id_stated,
    boundary_id_resolved: validated?.boundary_id_resolved ?? row.boundary_id_stated ?? null,
    field_name: row.field_name,
    strata_label: row.strata_label,
    elevation_class: row.elevation_class,
    sequence_no: row.sequence_no,
    access_note: row.access_note,
    prior_sample_uid: row.prior_sample_uid,
    // Unmapped columns, preserved. A column someone bothered to include is
    // information, and silently discarding it is how a tool loses trust on its
    // second use.
    extra_json: JSON.stringify(row.extra),
    operation_text: row.operation_text,
    operation_match_id: validated?.operation_match_id ?? null,
    operation_match_score: validated?.operation_match_score ?? null,
    operation_match_status: validated?.operation_match_status ?? null,
    contact_name_text: row.contact_name_text,
    contact_phone_text: row.contact_phone_text,
    contact_email_text: row.contact_email_text,
    contact_match_id: validated?.contact_match_id ?? null,
    contact_match_score: validated?.contact_match_score ?? null,
    contact_match_status: validated?.contact_match_status ?? null,
    row_status: validated?.row_status ?? 'ready',
    validation_codes: validated?.validation_codes ?? [],
  };
}

/**
 * Unresolved operations and contacts become analyst-queue items.
 *
 * They attach to the plan point, not to a CRM record, because there is no CRM
 * record — that is the entire point of D16. An analyst decides whether this is
 * a new operation or the fifty-fifth spelling of an existing one.
 */
function buildQueueItems(rows: CommitRow[]) {
  const items: Array<{
    defect_id: string;
    plan_point_id: string;
    defect_code: string;
    severity: string;
    detail: string;
  }> = [];

  for (const row of rows) {
    if (row.row_status === 'blocked' || !row.boundary_id_resolved) continue;
    const pointId = planPointId(row.import_row_id);

    if (row.operation_text && row.operation_match_status !== 'matched') {
      items.push({
        defect_id: queueDefectId(pointId, DEFECT_CODE.IMPORT_OPERATION_UNRESOLVED),
        plan_point_id: pointId,
        defect_code: DEFECT_CODE.IMPORT_OPERATION_UNRESOLVED,
        severity: 'review',
        detail: `uploaded operation "${row.operation_text}" is ${row.operation_match_status ?? 'unmatched'}`,
      });
    }
    if (row.contact_name_text && row.contact_match_status !== 'matched') {
      items.push({
        defect_id: queueDefectId(pointId, DEFECT_CODE.IMPORT_CONTACT_UNRESOLVED),
        plan_point_id: pointId,
        defect_code: DEFECT_CODE.IMPORT_CONTACT_UNRESOLVED,
        severity: 'advisory',
        detail: `uploaded contact "${row.contact_name_text}" is ${row.contact_match_status ?? 'unmatched'}`,
      });
    }
  }
  return items;
}

function rawBytes(request: IngestCommitRequest): Uint8Array {
  if (request.raw_file.content_b64) {
    return new Uint8Array(Buffer.from(request.raw_file.content_b64, 'base64'));
  }
  return new TextEncoder().encode(request.raw_file.raw_text ?? '');
}

async function findExistingImport(
  sf: SnowflakeClient,
  id: string,
): Promise<{ status: string; plan_ids: string[]; rows_committed: string | null; imported_ts: string | null } | null> {
  const rows = asObjects<Record<string, string | null>>(
    await sf.execute(
      `SELECT STATUS, PLAN_IDS, ROWS_COMMITTED, IMPORTED_TS
         FROM CURATED.PLAN_IMPORT WHERE IMPORT_ID = ?`,
      { binds: [id] },
    ),
  );
  const row = rows[0];
  if (!row) return null;
  let planIds: string[] = [];
  try {
    const parsed = JSON.parse(row.plan_ids ?? '[]') as unknown;
    if (Array.isArray(parsed)) planIds = parsed.map(String);
  } catch {
    planIds = [];
  }
  return {
    status: String(row.status ?? 'staged'),
    plan_ids: planIds,
    rows_committed: row.rows_committed ?? null,
    imported_ts: row.imported_ts ?? null,
  };
}

async function loadPriorPlans(
  sf: SnowflakeClient,
  boundaryIds: readonly string[],
  periodCode: string,
): Promise<Map<string, { plan_id: string; plan_version: number }>> {
  const map = new Map<string, { plan_id: string; plan_version: number }>();
  if (boundaryIds.length === 0) return map;

  const rows = asObjects<Record<string, string | null>>(
    await sf.execute(
      `SELECT BOUNDARY_ID, PLAN_ID, PLAN_VERSION
         FROM CURATED.SAMPLE_PLAN
        WHERE PERIOD_CODE = ?
          AND STATUS <> 'superseded'
          AND BOUNDARY_ID IN (${boundaryIds.map(() => '?').join(',')})
        QUALIFY ROW_NUMBER() OVER (PARTITION BY BOUNDARY_ID ORDER BY PLAN_VERSION DESC) = 1`,
      { binds: [periodCode, ...boundaryIds] },
    ),
  );
  for (const row of rows) {
    map.set(String(row.boundary_id), {
      plan_id: String(row.plan_id),
      plan_version: Number(row.plan_version ?? 0),
    });
  }
  return map;
}

const RAW_FILE_SQL = `INSERT INTO RAW.PLAN_IMPORT_FILE
  (CONTENT_HASH, ORIGINAL_FILENAME, MIME_TYPE, BYTES, SOURCE_KIND, BLOB_KEY,
   RAW_TEXT, UPLOADED_BY, UPLOADED_TS)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
 WHERE NOT EXISTS (SELECT 1 FROM RAW.PLAN_IMPORT_FILE WHERE CONTENT_HASH = ?)`;

const PLAN_IMPORT_SQL = `MERGE INTO CURATED.PLAN_IMPORT t
USING (SELECT ? AS IMPORT_ID, ? AS CONTENT_HASH, ? AS IMPORTED_BY, ? AS IMPORTED_TS,
              ? AS SOURCE_KIND, ? AS ORIGINAL_FILENAME, PARSE_JSON(?) AS MAPPING_JSON,
              ? AS PERIOD_CODE, ? AS PROJECT_ID, ? AS ROW_COUNT, ? AS ROWS_COMMITTED,
              ? AS ROWS_FLAGGED, ? AS ROWS_BLOCKED, PARSE_JSON(?) AS PLAN_IDS,
              ? AS STATUS) s
   ON t.IMPORT_ID = s.IMPORT_ID
 WHEN MATCHED THEN UPDATE SET
      ROWS_COMMITTED = s.ROWS_COMMITTED, ROWS_FLAGGED = s.ROWS_FLAGGED,
      ROWS_BLOCKED = s.ROWS_BLOCKED, PLAN_IDS = s.PLAN_IDS, STATUS = s.STATUS,
      LAST_UPDATED_TS = CURRENT_TIMESTAMP()
 WHEN NOT MATCHED THEN
      INSERT (IMPORT_ID, CONTENT_HASH, IMPORTED_BY, IMPORTED_TS, SOURCE_KIND,
              ORIGINAL_FILENAME, MAPPING_JSON, PERIOD_CODE, PROJECT_ID, ROW_COUNT,
              ROWS_COMMITTED, ROWS_FLAGGED, ROWS_BLOCKED, PLAN_IDS, STATUS)
      VALUES (s.IMPORT_ID, s.CONTENT_HASH, s.IMPORTED_BY, s.IMPORTED_TS, s.SOURCE_KIND,
              s.ORIGINAL_FILENAME, s.MAPPING_JSON, s.PERIOD_CODE, s.PROJECT_ID, s.ROW_COUNT,
              s.ROWS_COMMITTED, s.ROWS_FLAGGED, s.ROWS_BLOCKED, s.PLAN_IDS, s.STATUS)`;

const PLAN_IMPORT_ROW_SQL = `MERGE INTO CURATED.PLAN_IMPORT_ROW t
USING (
  SELECT v.value:import_row_id::VARCHAR          AS IMPORT_ROW_ID,
         v.value:import_id::VARCHAR              AS IMPORT_ID,
         v.value:source_row_no::NUMBER           AS SOURCE_ROW_NO,
         PARSE_JSON(v.value:raw_values_json::VARCHAR) AS RAW_VALUES_JSON,
         v.value:plan_point_label::VARCHAR       AS PLAN_POINT_LABEL,
         v.value:lat_raw::VARCHAR                AS LAT_RAW,
         v.value:lon_raw::VARCHAR                AS LON_RAW,
         v.value:lat::FLOAT                      AS LAT,
         v.value:lon::FLOAT                      AS LON,
         v.value:coord_format_detected::VARCHAR  AS COORD_FORMAT_DETECTED,
         v.value:coord_fix_applied::VARCHAR      AS COORD_FIX_APPLIED,
         v.value:boundary_id_stated::VARCHAR     AS BOUNDARY_ID_STATED,
         v.value:boundary_id_resolved::VARCHAR   AS BOUNDARY_ID_RESOLVED,
         v.value:field_name::VARCHAR             AS FIELD_NAME,
         v.value:strata_label::VARCHAR           AS STRATA_LABEL,
         v.value:elevation_class::VARCHAR        AS ELEVATION_CLASS,
         v.value:sequence_no::NUMBER             AS SEQUENCE_NO,
         v.value:access_note::VARCHAR            AS ACCESS_NOTE,
         v.value:prior_sample_uid::VARCHAR       AS PRIOR_SAMPLE_UID,
         PARSE_JSON(v.value:extra_json::VARCHAR) AS EXTRA_JSON,
         v.value:operation_text::VARCHAR         AS OPERATION_TEXT,
         v.value:operation_match_id::VARCHAR     AS OPERATION_MATCH_ID,
         v.value:operation_match_score::FLOAT    AS OPERATION_MATCH_SCORE,
         v.value:operation_match_status::VARCHAR AS OPERATION_MATCH_STATUS,
         v.value:contact_name_text::VARCHAR      AS CONTACT_NAME_TEXT,
         v.value:contact_phone_text::VARCHAR     AS CONTACT_PHONE_TEXT,
         v.value:contact_email_text::VARCHAR     AS CONTACT_EMAIL_TEXT,
         v.value:contact_match_id::VARCHAR       AS CONTACT_MATCH_ID,
         v.value:contact_match_score::FLOAT      AS CONTACT_MATCH_SCORE,
         v.value:contact_match_status::VARCHAR   AS CONTACT_MATCH_STATUS,
         v.value:row_status::VARCHAR             AS ROW_STATUS,
         v.value:validation_codes                AS VALIDATION_CODES
    FROM TABLE(FLATTEN(input => PARSE_JSON(?))) v
) s
   ON t.IMPORT_ROW_ID = s.IMPORT_ROW_ID
 WHEN MATCHED THEN UPDATE SET
      ROW_STATUS = s.ROW_STATUS, VALIDATION_CODES = s.VALIDATION_CODES,
      BOUNDARY_ID_RESOLVED = s.BOUNDARY_ID_RESOLVED,
      LAST_UPDATED_TS = CURRENT_TIMESTAMP()
 WHEN NOT MATCHED THEN
      INSERT (IMPORT_ROW_ID, IMPORT_ID, SOURCE_ROW_NO, RAW_VALUES_JSON, PLAN_POINT_LABEL,
              LAT_RAW, LON_RAW, LAT, LON, COORD_FORMAT_DETECTED, COORD_FIX_APPLIED,
              BOUNDARY_ID_STATED, BOUNDARY_ID_RESOLVED, FIELD_NAME, STRATA_LABEL,
              ELEVATION_CLASS, SEQUENCE_NO, ACCESS_NOTE, PRIOR_SAMPLE_UID, EXTRA_JSON,
              OPERATION_TEXT, OPERATION_MATCH_ID, OPERATION_MATCH_SCORE,
              OPERATION_MATCH_STATUS, CONTACT_NAME_TEXT, CONTACT_PHONE_TEXT,
              CONTACT_EMAIL_TEXT, CONTACT_MATCH_ID, CONTACT_MATCH_SCORE,
              CONTACT_MATCH_STATUS, ROW_STATUS, VALIDATION_CODES)
      VALUES (s.IMPORT_ROW_ID, s.IMPORT_ID, s.SOURCE_ROW_NO, s.RAW_VALUES_JSON,
              s.PLAN_POINT_LABEL, s.LAT_RAW, s.LON_RAW, s.LAT, s.LON,
              s.COORD_FORMAT_DETECTED, s.COORD_FIX_APPLIED, s.BOUNDARY_ID_STATED,
              s.BOUNDARY_ID_RESOLVED, s.FIELD_NAME, s.STRATA_LABEL, s.ELEVATION_CLASS,
              s.SEQUENCE_NO, s.ACCESS_NOTE, s.PRIOR_SAMPLE_UID, s.EXTRA_JSON,
              s.OPERATION_TEXT, s.OPERATION_MATCH_ID, s.OPERATION_MATCH_SCORE,
              s.OPERATION_MATCH_STATUS, s.CONTACT_NAME_TEXT, s.CONTACT_PHONE_TEXT,
              s.CONTACT_EMAIL_TEXT, s.CONTACT_MATCH_ID, s.CONTACT_MATCH_SCORE,
              s.CONTACT_MATCH_STATUS, s.ROW_STATUS, s.VALIDATION_CODES)`;

// Upsert-never-delete: the old plan is marked superseded, never removed. Its
// points stay queryable, which is what makes "where did this point come from"
// answerable a year later.
const SUPERSEDE_PLANS_SQL = `UPDATE CURATED.SAMPLE_PLAN
   SET STATUS = 'superseded', LAST_UPDATED_TS = CURRENT_TIMESTAMP()
 WHERE PLAN_ID IN (
   SELECT v.value::VARCHAR FROM TABLE(FLATTEN(input => PARSE_JSON(?))) v
 )`;

const SAMPLE_PLAN_SQL = `MERGE INTO CURATED.SAMPLE_PLAN t
USING (
  SELECT v.value:plan_id::VARCHAR        AS PLAN_ID,
         v.value:boundary_id::VARCHAR    AS BOUNDARY_ID,
         v.value:period_code::VARCHAR    AS PERIOD_CODE,
         v.value:plan_version::NUMBER    AS PLAN_VERSION,
         v.value:parent_plan_id::VARCHAR AS PARENT_PLAN_ID,
         v.value:point_count::NUMBER     AS POINT_COUNT,
         v.value:import_id::VARCHAR      AS IMPORT_ID
    FROM TABLE(FLATTEN(input => PARSE_JSON(?))) v
) s
   ON t.PLAN_ID = s.PLAN_ID
 WHEN MATCHED THEN UPDATE SET
      POINT_COUNT = s.POINT_COUNT, LAST_UPDATED_TS = CURRENT_TIMESTAMP()
 WHEN NOT MATCHED THEN
      INSERT (PLAN_ID, BOUNDARY_ID, SPEC_ID, PERIOD_CODE, PLAN_VERSION, PARENT_PLAN_ID,
              STATUS, POINT_COUNT, GENERATION_METHOD, RELEASED_TS, RELEASED_BY, IMPORT_ID)
      VALUES (s.PLAN_ID, s.BOUNDARY_ID, '', s.PERIOD_CODE, s.PLAN_VERSION, s.PARENT_PLAN_ID,
              'released', s.POINT_COUNT, 'plan_import', ?, ?, s.IMPORT_ID)`;

const SAMPLE_PLAN_POINT_SQL = `MERGE INTO CURATED.SAMPLE_PLAN_POINT t
USING (
  SELECT v.value:plan_point_id::VARCHAR    AS PLAN_POINT_ID,
         v.value:plan_id::VARCHAR          AS PLAN_ID,
         v.value:plan_point_label::VARCHAR AS PLAN_POINT_LABEL,
         v.value:planned_lat::FLOAT        AS PLANNED_LAT,
         v.value:planned_lon::FLOAT        AS PLANNED_LON,
         TRY_TO_GEOGRAPHY('POINT(' || v.value:planned_lon::VARCHAR || ' ' ||
                          v.value:planned_lat::VARCHAR || ')') AS PLANNED_GEOG,
         v.value:strata_label::VARCHAR     AS STRATA_LABEL,
         v.value:elevation_class::VARCHAR  AS ELEVATION_CLASS,
         v.value:prior_sample_uid::VARCHAR AS PRIOR_SAMPLE_UID,
         v.value:sequence_no::NUMBER       AS SEQUENCE_NO,
         v.value:access_note::VARCHAR      AS ACCESS_NOTE,
         v.value:import_row_id::VARCHAR    AS IMPORT_ROW_ID
    FROM TABLE(FLATTEN(input => PARSE_JSON(?))) v
) s
   ON t.PLAN_POINT_ID = s.PLAN_POINT_ID
 WHEN MATCHED THEN UPDATE SET
      PLANNED_LAT = s.PLANNED_LAT, PLANNED_LON = s.PLANNED_LON,
      PLANNED_GEOG = s.PLANNED_GEOG, LAST_UPDATED_TS = CURRENT_TIMESTAMP()
 WHEN NOT MATCHED THEN
      INSERT (PLAN_POINT_ID, PLAN_ID, PLAN_POINT_LABEL, PLANNED_LAT, PLANNED_LON,
              PLANNED_GEOG, STRATA_LABEL, ELEVATION_CLASS, PRIOR_SAMPLE_UID,
              SEQUENCE_NO, ACCESS_NOTE, IMPORT_ROW_ID)
      VALUES (s.PLAN_POINT_ID, s.PLAN_ID, s.PLAN_POINT_LABEL, s.PLANNED_LAT, s.PLANNED_LON,
              s.PLANNED_GEOG, s.STRATA_LABEL, s.ELEVATION_CLASS, s.PRIOR_SAMPLE_UID,
              s.SEQUENCE_NO, s.ACCESS_NOTE, s.IMPORT_ROW_ID)`;

const STAMP_ROW_POINTS_SQL = `UPDATE CURATED.PLAN_IMPORT_ROW r
   SET PLAN_POINT_ID = pp.PLAN_POINT_ID,
       ROW_STATUS = 'committed',
       LAST_UPDATED_TS = CURRENT_TIMESTAMP()
  FROM CURATED.SAMPLE_PLAN_POINT pp
 WHERE pp.IMPORT_ROW_ID = r.IMPORT_ROW_ID
   AND r.IMPORT_ID = ?`;

const QUEUE_ITEMS_SQL = `MERGE INTO CURATED.SAMPLE_DEFECT t
USING (
  SELECT v.value:defect_id::VARCHAR     AS DEFECT_ID,
         v.value:plan_point_id::VARCHAR AS PLAN_POINT_ID,
         v.value:defect_code::VARCHAR   AS DEFECT_CODE,
         v.value:severity::VARCHAR      AS SEVERITY,
         v.value:detail::VARCHAR        AS DETAIL
    FROM TABLE(FLATTEN(input => PARSE_JSON(?))) v
) s
   ON t.DEFECT_ID = s.DEFECT_ID
 WHEN MATCHED AND t.RESOLUTION_STATE = 'open' THEN UPDATE SET
      DETAIL = s.DETAIL, LAST_UPDATED_TS = CURRENT_TIMESTAMP()
 WHEN NOT MATCHED THEN
      INSERT (DEFECT_ID, PLAN_POINT_ID, DEFECT_CODE, SEVERITY, DETECTED_BY,
              DETECTED_TS, DETAIL, RESOLUTION_STATE, VISIBLE_TO_FIELD)
      VALUES (s.DEFECT_ID, s.PLAN_POINT_ID, s.DEFECT_CODE, s.SEVERITY, 'server_rule',
              CURRENT_TIMESTAMP(), s.DETAIL, 'open', FALSE)`;

const AUDIT_SQL = `INSERT INTO CURATED.AUDIT_EVENT
  (EVENT_ID, EVENT_TS, ACTOR_REF, ACTOR_KIND, SURFACE, ACTION, ENTITY_TYPE,
   ENTITY_ID, DETAIL_JSON, IP_HASH, USER_AGENT_RAW)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, PARSE_JSON(?), ?, ?`;
