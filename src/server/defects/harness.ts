/**
 * A7 — the defect rule harness. Contract §6 step 7.
 *
 * Loads a batch's context once, runs every registered rule over it, and writes
 * the findings in one idempotent MERGE.
 *
 * Three properties, each of which a rule would otherwise have to get right on
 * its own — and one of them would not:
 *
 *  - **Idempotent per `sync_batch_id`.** The defect id is
 *    `MD5(subject_id|defect_code)`, so a re-run updates rather than duplicates.
 *    v02 §11 criterion 3 says *exactly one defect row*, and the nightly sweep
 *    can re-kick any batch, so this is the difference between the criterion
 *    holding and holding until the first network hiccup.
 *  - **`VISIBLE_TO_FIELD` from `REF.DEFECT_FIELD_VISIBILITY`,** defaulting
 *    closed. A rule does not get to decide it deserves a crew's attention.
 *  - **A rule that throws does not take the batch down.** Its findings are
 *    lost and recorded as such; the other rules still run.
 */

import { createHash } from 'node:crypto';
import type { SnowflakeClient } from '../../shared/snowflake/client.js';
import { asObjects } from '../../shared/snowflake/client.js';
import { DEFAULT_SEVERITY, type DefectCode } from '../../shared/codes/index.js';
import type {
  DefectFinding,
  DefectRule,
  RuleBag,
  RuleContext,
  RuleMedia,
  RuleSample,
  RuleSpec,
} from './types.js';
import { defaultRules } from './rules/index.js';

export interface DefectHarnessDeps {
  snowflake: SnowflakeClient;
  rules?: DefectRule[];
  /** Surfaces a rule that threw. Defaults to `console.error`. */
  onRuleError?: (rule: string, error: unknown) => void;
}

/** Deterministic, and identical to the pipeline's SQL `MD5(subject || '|' || code)`. */
export function defectId(subjectId: string, defectCode: string): string {
  return createHash('md5').update(`${subjectId}|${defectCode}`).digest('hex');
}

export async function runDefectRules(
  syncBatchId: string,
  deps: DefectHarnessDeps,
): Promise<number> {
  const rules = deps.rules ?? defaultRules();
  const ctx = await loadContext(syncBatchId, deps.snowflake);

  const findings: DefectFinding[] = [];
  for (const rule of rules) {
    try {
      findings.push(...rule.run(ctx));
    } catch (err) {
      (deps.onRuleError ?? defaultOnRuleError)(rule.code, err);
    }
  }
  if (findings.length === 0) return 0;

  await writeFindings(deps.snowflake, findings);
  return findings.length;
}

function defaultOnRuleError(rule: string, error: unknown): void {
  console.error(`defect rule ${rule} threw; its findings are missing from this run`, error);
}

/**
 * One round trip per table, not per sample.
 *
 * The `knownBarcodes` query deliberately excludes this batch: a duplicate rule
 * needs "already seen elsewhere", and including the batch's own rows would make
 * every bag its own duplicate.
 */
export async function loadContext(
  syncBatchId: string,
  sf: SnowflakeClient,
): Promise<RuleContext> {
  const samplesRaw = asObjects<Record<string, string | null>>(
    await sf.execute(
      `SELECT SAMPLE_UID, VISIT_ID, PLAN_POINT_ID, BOUNDARY_ID, LAT, LON,
              GPS_ACCURACY_M, FIX_COUNT, FIX_SPREAD_M, POSITION_SOURCE,
              OFFSET_FROM_PLAN_M, DEVIATION_REASON_CODE, CAPTURED_TS_DEVICE,
              DEVICE_UPTIME_MS, SERVER_RECEIVED_TS, DEPTH_ACHIEVED_CM, SPEC_ID
         FROM CURATED.SAMPLE_POINT WHERE SYNC_BATCH_ID = ?`,
      { binds: [syncBatchId] },
    ),
  );
  const samples = samplesRaw.map(toSample);

  const bags = asObjects<Record<string, string | null>>(
    await sf.execute(
      `SELECT BAG_ID, SAMPLE_UID, LAB_ID, BARCODE_RAW, BARCODE_CAPTURE_METHOD, VOID_FLAG
         FROM CURATED.SAMPLE_BAG WHERE SYNC_BATCH_ID = ?`,
      { binds: [syncBatchId] },
    ),
  ).map(toBag);

  const media = asObjects<Record<string, string | null>>(
    await sf.execute(
      `SELECT MEDIA_ID, SAMPLE_UID, MEDIA_ROLE, IS_REQUIRED_ROLE, CAPTURE_SOURCE,
              EXIF_LAT, EXIF_LON, EXIF_TS
         FROM CURATED.MEDIA WHERE SYNC_BATCH_ID = ?`,
      { binds: [syncBatchId] },
    ),
  ).map(toMedia);

  const specs = new Map<string, RuleSpec>();
  const specIds = [...new Set(samples.map((s) => s.spec_id).filter((x): x is string => !!x))];
  if (specIds.length > 0) {
    const rows = asObjects<Record<string, string | null>>(
      await sf.execute(
        `SELECT SPEC_ID, REQUIRED_MEDIA_ROLES, GPS_ACCURACY_REQUIRED_M, MIN_GPS_FIX_COUNT,
                MAX_PLAN_OFFSET_M_WARN, MAX_PLAN_OFFSET_M_BLOCK, DEPTH_TOP_CM, DEPTH_BOTTOM_CM
           FROM REF.PROJECT_SAMPLING_SPEC
          WHERE SPEC_ID IN (${specIds.map(() => '?').join(',')})`,
        { binds: specIds },
      ),
    );
    for (const row of rows) specs.set(String(row.spec_id), toSpec(row));
  }

  const knownBarcodes = new Map<string, string>();
  if (bags.length > 0) {
    const rows = asObjects<Record<string, string | null>>(
      await sf.execute(
        `SELECT BAG_ID, LAB_ID, BARCODE_RAW
           FROM CURATED.SAMPLE_BAG
          WHERE VOID_FLAG = FALSE
            AND COALESCE(SYNC_BATCH_ID, '') <> ?
            AND BARCODE_RAW IN (${bags.map(() => '?').join(',')})`,
        { binds: [syncBatchId, ...bags.map((b) => b.barcode_raw ?? '')] },
      ),
    );
    for (const row of rows) {
      knownBarcodes.set(`${row.lab_id ?? ''}|${row.barcode_raw ?? ''}`, String(row.bag_id));
    }
  }

  return { sync_batch_id: syncBatchId, samples, bags, media, specs, knownBarcodes };
}

/**
 * One MERGE for every finding, keyed on the deterministic defect id.
 *
 * `WHEN MATCHED AND t.RESOLUTION_STATE = 'open'` — a defect an analyst has
 * already resolved is not re-opened by a re-run. Re-opening resolved work is
 * how an analyst learns to distrust the queue.
 */
async function writeFindings(sf: SnowflakeClient, findings: DefectFinding[]): Promise<void> {
  const rows = findings.map((f) => {
    const subject = f.sample_uid ?? f.bag_id ?? f.visit_id ?? f.plan_point_id ?? '';
    return {
      defect_id: defectId(subject, f.defect_code),
      sample_uid: f.sample_uid ?? null,
      bag_id: f.bag_id ?? null,
      visit_id: f.visit_id ?? null,
      plan_point_id: f.plan_point_id ?? null,
      defect_code: f.defect_code,
      severity: f.severity ?? DEFAULT_SEVERITY[f.defect_code as DefectCode] ?? 'review',
      detail: f.detail,
    };
  });

  await sf.execute(
    `MERGE INTO CURATED.SAMPLE_DEFECT t
     USING (
       SELECT v.value:defect_id::VARCHAR      AS DEFECT_ID,
              v.value:sample_uid::VARCHAR     AS SAMPLE_UID,
              v.value:bag_id::VARCHAR         AS BAG_ID,
              v.value:visit_id::VARCHAR       AS VISIT_ID,
              v.value:plan_point_id::VARCHAR  AS PLAN_POINT_ID,
              v.value:defect_code::VARCHAR    AS DEFECT_CODE,
              v.value:severity::VARCHAR       AS SEVERITY,
              v.value:detail::VARCHAR         AS DETAIL,
              COALESCE(vis.VISIBLE_TO_FIELD, FALSE) AS VISIBLE_TO_FIELD
         FROM TABLE(FLATTEN(input => PARSE_JSON(?))) v
         LEFT JOIN REF.DEFECT_FIELD_VISIBILITY vis
                ON vis.DEFECT_CODE = v.value:defect_code::VARCHAR
     ) s
        ON t.DEFECT_ID = s.DEFECT_ID
      WHEN MATCHED AND t.RESOLUTION_STATE = 'open' THEN UPDATE SET
           DETAIL = s.DETAIL,
           SEVERITY = s.SEVERITY,
           VISIBLE_TO_FIELD = s.VISIBLE_TO_FIELD,
           LAST_UPDATED_TS = CURRENT_TIMESTAMP()
      WHEN NOT MATCHED THEN
           INSERT (DEFECT_ID, SAMPLE_UID, BAG_ID, VISIT_ID, PLAN_POINT_ID, DEFECT_CODE,
                   SEVERITY, DETECTED_BY, DETECTED_TS, DETAIL, RESOLUTION_STATE,
                   VISIBLE_TO_FIELD)
           VALUES (s.DEFECT_ID, s.SAMPLE_UID, s.BAG_ID, s.VISIT_ID, s.PLAN_POINT_ID,
                   s.DEFECT_CODE, s.SEVERITY, 'server_rule', CURRENT_TIMESTAMP(), s.DETAIL,
                   'open', s.VISIBLE_TO_FIELD)`,
    { binds: [JSON.stringify(rows)] },
  );
}

const num = (v: string | null): number | null => (v === null || v === '' ? null : Number(v));
const bool = (v: string | null): boolean => v === 'true' || v === '1' || v === 'TRUE';

function toSample(row: Record<string, string | null>): RuleSample {
  return {
    sample_uid: String(row.sample_uid),
    visit_id: row.visit_id ?? null,
    plan_point_id: row.plan_point_id ?? null,
    boundary_id: row.boundary_id ?? null,
    lat: num(row.lat ?? null),
    lon: num(row.lon ?? null),
    gps_accuracy_m: num(row.gps_accuracy_m ?? null),
    fix_count: num(row.fix_count ?? null),
    fix_spread_m: num(row.fix_spread_m ?? null),
    position_source: row.position_source ?? null,
    offset_from_plan_m: num(row.offset_from_plan_m ?? null),
    deviation_reason_code: row.deviation_reason_code ?? null,
    captured_ts_device: row.captured_ts_device ?? null,
    device_uptime_ms: num(row.device_uptime_ms ?? null),
    server_received_ts: row.server_received_ts ?? null,
    depth_achieved_cm: num(row.depth_achieved_cm ?? null),
    spec_id: row.spec_id ?? null,
  };
}

function toBag(row: Record<string, string | null>): RuleBag {
  return {
    bag_id: String(row.bag_id),
    sample_uid: String(row.sample_uid),
    lab_id: row.lab_id ?? null,
    barcode_raw: row.barcode_raw ?? null,
    barcode_capture_method: row.barcode_capture_method ?? null,
    void_flag: bool(row.void_flag ?? null),
  };
}

function toMedia(row: Record<string, string | null>): RuleMedia {
  return {
    media_id: String(row.media_id),
    sample_uid: row.sample_uid ?? null,
    media_role: String(row.media_role ?? ''),
    is_required_role: bool(row.is_required_role ?? null),
    capture_source: String(row.capture_source ?? 'unknown'),
    exif_lat: num(row.exif_lat ?? null),
    exif_lon: num(row.exif_lon ?? null),
    exif_ts: row.exif_ts ?? null,
  };
}

function toSpec(row: Record<string, string | null>): RuleSpec {
  let roles: string[] = [];
  try {
    const parsed = JSON.parse(row.required_media_roles ?? '[]') as unknown;
    if (Array.isArray(parsed)) roles = parsed.map(String);
  } catch {
    roles = [];
  }
  return {
    spec_id: String(row.spec_id),
    required_media_roles: roles,
    gps_accuracy_required_m: num(row.gps_accuracy_required_m ?? null),
    min_gps_fix_count: num(row.min_gps_fix_count ?? null),
    max_plan_offset_m_warn: num(row.max_plan_offset_m_warn ?? null),
    max_plan_offset_m_block: num(row.max_plan_offset_m_block ?? null),
    depth_top_cm: num(row.depth_top_cm ?? null),
    depth_bottom_cm: num(row.depth_bottom_cm ?? null),
  };
}
