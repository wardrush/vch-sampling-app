/**
 * A6 — the post-sync derivation pipeline. Contract §6 steps 3–6 and 8,
 * addendum §4.4.
 *
 * Runs as a Netlify **background** function (15-minute ceiling) triggered after
 * a batch lands. Its payload is a `sync_batch_id`, never data — the background
 * payload cap is 256 KB and a batch is up to 2 MB.
 *
 * Every step is **ordered, idempotent and re-runnable per `sync_batch_id`**.
 * Idempotence is not a nicety here: the nightly sweep re-kicks batches whose
 * derivation never ran, so any step that double-counted would double-count
 * every time the network hiccupped.
 *
 * Steps 3–8 are pure functions of the raw payload plus reference data, which is
 * what makes the whole curated layer rebuildable from RAW. Nothing in this file
 * reads anything the device asserted about a derived value.
 */

import type { SnowflakeClient } from '../../shared/snowflake/client.js';
import { asObjects } from '../../shared/snowflake/client.js';
import { DEFECT_CODE } from '../../shared/codes/index.js';
import { runDefectRules, type DefectHarnessDeps } from '../defects/harness.js';

export interface PipelineResult {
  sync_batch_id: string;
  steps: string[];
  defects_raised: number;
  samples_screened: number;
  samples_needing_review: number;
}

export interface PipelineDeps {
  snowflake: SnowflakeClient;
  harness?: Omit<DefectHarnessDeps, 'snowflake'>;
}

export async function runDerivationPipeline(
  syncBatchId: string,
  deps: PipelineDeps,
): Promise<PipelineResult> {
  const sf = deps.snowflake;
  const steps: string[] = [];

  // --- Step 3. Geography. Invalid geometry degrades to a defect, never fails
  // the batch — a point with a mangled coordinate is still a bag in a box.
  await sf.execute(
    `UPDATE CURATED.SAMPLE_POINT
        SET GEOG = TRY_TO_GEOGRAPHY('POINT(' || LON || ' ' || LAT || ')'),
            GEOG_VALID = TRY_TO_GEOGRAPHY('POINT(' || LON || ' ' || LAT || ')') IS NOT NULL,
            LAST_UPDATED_TS = CURRENT_TIMESTAMP()
      WHERE SYNC_BATCH_ID = ?
        AND LAT IS NOT NULL AND LON IS NOT NULL`,
    { binds: [syncBatchId] },
  );
  await sf.execute(
    `UPDATE CURATED.SAMPLE_POINT
        SET GEOG_VALID = FALSE
      WHERE SYNC_BATCH_ID = ? AND (LAT IS NULL OR LON IS NULL)`,
    { binds: [syncBatchId] },
  );
  steps.push('geography');

  await raiseDefectFromQuery(
    sf,
    DEFECT_CODE.GEOM_INVALID,
    'blocking',
    `SELECT SAMPLE_UID, 'lat/lon did not parse to a valid geography' AS DETAIL
       FROM CURATED.SAMPLE_POINT
      WHERE SYNC_BATCH_ID = ? AND COALESCE(GEOG_VALID, FALSE) = FALSE`,
    syncBatchId,
  );

  // --- Step 4. Point-in-polygon → BOUNDARY_ID.
  // Flags, never drops. A point 20 m outside a boundary is usually a boundary
  // problem, and the analyst queue is where that gets decided.
  await sf.execute(
    `UPDATE CURATED.SAMPLE_POINT sp
        SET BOUNDARY_ID = b.BOUNDARY_ID,
            LAST_UPDATED_TS = CURRENT_TIMESTAMP()
       FROM CURATED.BOUNDARY b
      WHERE sp.SYNC_BATCH_ID = ?
        AND sp.BOUNDARY_ID IS NULL
        AND sp.GEOG_VALID = TRUE
        AND b.STATUS = 'active'
        AND ST_WITHIN(sp.GEOG, b.GEOG)`,
    { binds: [syncBatchId] },
  );
  steps.push('point_in_polygon');

  await raiseDefectFromQuery(
    sf,
    DEFECT_CODE.POINT_OUTSIDE_BOUNDARY,
    'blocking',
    `SELECT SAMPLE_UID, 'no active boundary contains this point' AS DETAIL
       FROM CURATED.SAMPLE_POINT
      WHERE SYNC_BATCH_ID = ? AND GEOG_VALID = TRUE AND BOUNDARY_ID IS NULL`,
    syncBatchId,
  );

  // --- Step 5. TRS, derived and never accepted from the device.
  //
  // Sourced from the containing boundary's canonical TRS. A PLSS reference
  // layer would be the better source and would also cover points that fall
  // outside every boundary; the layer's live table name is not settled in the
  // schema docs, so this takes the answer that is definitely available and
  // leaves the point outside a boundary with a NULL rather than a guess.
  await sf.execute(
    `UPDATE CURATED.SAMPLE_POINT sp
        SET TRS_CANONICAL = b.TRS_CANONICAL,
            LAST_UPDATED_TS = CURRENT_TIMESTAMP()
       FROM CURATED.BOUNDARY b
      WHERE sp.SYNC_BATCH_ID = ?
        AND sp.BOUNDARY_ID = b.BOUNDARY_ID
        AND sp.TRS_CANONICAL IS NULL`,
    { binds: [syncBatchId] },
  );
  steps.push('trs');

  // --- Step 6. Offset and bearing from plan. One implementation, one answer.
  await sf.execute(
    `UPDATE CURATED.SAMPLE_POINT sp
        SET OFFSET_FROM_PLAN_M = ST_DISTANCE(sp.GEOG, pp.PLANNED_GEOG),
            BEARING_FROM_PLAN_DEG = DEGREES(
              ST_AZIMUTH(pp.PLANNED_GEOG, sp.GEOG)
            ),
            LAST_UPDATED_TS = CURRENT_TIMESTAMP()
       FROM CURATED.SAMPLE_PLAN_POINT pp
      WHERE sp.SYNC_BATCH_ID = ?
        AND sp.PLAN_POINT_ID = pp.PLAN_POINT_ID
        AND sp.GEOG_VALID = TRUE
        AND pp.PLANNED_GEOG IS NOT NULL`,
    { binds: [syncBatchId] },
  );
  steps.push('offset_from_plan');

  // --- Step 7. The server-rule defect set (A7 harness, A8 rules).
  const defectsRaised = await runDefectRules(syncBatchId, {
    snowflake: sf,
    ...(deps.harness ?? {}),
  });
  steps.push('defect_rules');

  // --- Step 8. Review state. `screened` if no open defect, else `needs_review`.
  //
  // `accepted` is an analyst's word and this never overwrites it — contract §1
  // property 5 is enforced on the write path and respected here.
  await sf.execute(
    `UPDATE CURATED.SAMPLE_POINT sp
        SET REVIEW_STATE = CASE
              WHEN EXISTS (
                SELECT 1 FROM CURATED.SAMPLE_DEFECT d
                 WHERE d.SAMPLE_UID = sp.SAMPLE_UID AND d.RESOLUTION_STATE = 'open'
              ) THEN 'needs_review'
              ELSE 'screened'
            END,
            LAST_UPDATED_TS = CURRENT_TIMESTAMP()
      WHERE sp.SYNC_BATCH_ID = ?
        AND COALESCE(sp.REVIEW_STATE, 'captured') NOT IN ('accepted', 'rejected')`,
    { binds: [syncBatchId] },
  );
  steps.push('review_state');

  const counts = asObjects<{ review_state: string; n: string }>(
    await sf.execute(
      `SELECT REVIEW_STATE, COUNT(*) AS N FROM CURATED.SAMPLE_POINT
        WHERE SYNC_BATCH_ID = ? GROUP BY REVIEW_STATE`,
      { binds: [syncBatchId] },
    ),
  );
  const countOf = (state: string) =>
    Number(counts.find((c) => c.review_state === state)?.n ?? 0);

  return {
    sync_batch_id: syncBatchId,
    steps,
    defects_raised: defectsRaised,
    samples_screened: countOf('screened'),
    samples_needing_review: countOf('needs_review'),
  };
}

/**
 * Raises one defect per row a query returns, idempotently.
 *
 * The trick that makes re-running safe is the **deterministic defect id**:
 * `MD5(sample_uid || defect_code)`. Re-running the pipeline over a batch
 * updates the same row rather than raising a second one, which is what v02 §11
 * criterion 3 — *exactly one defect row* — actually requires once the nightly
 * sweep can re-kick a batch.
 *
 * `VISIBLE_TO_FIELD` comes from `REF.DEFECT_FIELD_VISIBILITY` (addendum §4.2),
 * defaulting closed. A crew's list should contain only what a crew can act on.
 *
 * @param selectSql must yield `SAMPLE_UID` and `DETAIL`, and must contain
 *   exactly one `?` for the batch id. Binds are positional, so that placeholder
 *   sits fourth in the array below — between the severity and the two
 *   reference-table joins.
 */
export async function raiseDefectFromQuery(
  sf: SnowflakeClient,
  defectCode: string,
  severity: string,
  selectSql: string,
  syncBatchId: string,
): Promise<void> {
  await sf.execute(
    `MERGE INTO CURATED.SAMPLE_DEFECT t
     USING (
       SELECT MD5(q.SAMPLE_UID || '|' || ?) AS DEFECT_ID,
              q.SAMPLE_UID,
              ? AS DEFECT_CODE,
              COALESCE(vis_sev.DEFAULT_SEVERITY, ?) AS SEVERITY,
              q.DETAIL,
              COALESCE(vis.VISIBLE_TO_FIELD, FALSE) AS VISIBLE_TO_FIELD
         FROM (${selectSql}) q
         LEFT JOIN REF.DEFECT_FIELD_VISIBILITY vis ON vis.DEFECT_CODE = ?
         LEFT JOIN REF.DEFECT_CODE vis_sev ON vis_sev.DEFECT_CODE = ?
     ) s
        ON t.DEFECT_ID = s.DEFECT_ID
      WHEN MATCHED AND t.RESOLUTION_STATE = 'open' THEN UPDATE SET
           DETAIL = s.DETAIL,
           SEVERITY = s.SEVERITY,
           VISIBLE_TO_FIELD = s.VISIBLE_TO_FIELD,
           LAST_UPDATED_TS = CURRENT_TIMESTAMP()
      WHEN NOT MATCHED THEN
           INSERT (DEFECT_ID, SAMPLE_UID, DEFECT_CODE, SEVERITY, DETECTED_BY,
                   DETECTED_TS, DETAIL, RESOLUTION_STATE, VISIBLE_TO_FIELD)
           VALUES (s.DEFECT_ID, s.SAMPLE_UID, s.DEFECT_CODE, s.SEVERITY, 'server_rule',
                   CURRENT_TIMESTAMP(), s.DETAIL, 'open', s.VISIBLE_TO_FIELD)`,
    { binds: [defectCode, defectCode, severity, syncBatchId, defectCode, defectCode] },
  );
}
