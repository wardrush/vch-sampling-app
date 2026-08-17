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
 *
 * ## Geospatial is deferred on the Netlify database, and that is recorded
 *
 * `capabilities.geospatial` is `false` on Postgres — there is no PostGIS — so
 * `ST_WITHIN`, `ST_DISTANCE` and `ST_AZIMUTH` do not run and steps 4, 5 and 6
 * are skipped. **Skipped is not the same as passed**, and the difference is
 * written down in three places rather than left in a log line:
 *
 *  - per row, `SAMPLE_POINT.GEO_DERIVATION_STATE = 'deferred_no_geospatial'`;
 *  - per run, a `CURATED.DERIVATION_RUN` row naming the steps skipped and the
 *    defect rules whose input was never computed;
 *  - in the terminal state, which is `screened_partial` rather than `screened`
 *    (`cleanReviewStateFor`). A CHECK constraint refuses `screened` without a
 *    derived geo state, so this path *cannot* claim a pass it did not perform.
 *
 * Two defect rules depend on those computations — `POINT_OUTSIDE_BOUNDARY`
 * (from `ST_WITHIN`) and `OFFSET_EXCEEDED_NO_REASON` (from `OFFSET_FROM_PLAN_M`,
 * i.e. `ST_DISTANCE`). Neither is raised here when the input is absent, because
 * raising them would be a false positive on every row; both are listed in the
 * run's `rules_not_run`, because *not* listing them is how an auditor in 2029
 * mistakes an unchecked sample for a clean one.
 */

import { uuidv7 } from 'uuidv7';
import type { SqlClient, SqlDialect } from '../../shared/db/port.js';
import { asObjects } from '../../shared/db/port.js';
import type { SnowflakeClient } from '../../shared/snowflake/client.js';
import {
  cleanReviewStateFor,
  geoStateForCapability,
  GEO_DERIVATION_STATE,
  type GeoDerivationState,
  type ReviewState,
} from '../../shared/db/geo-assurance.js';
import { DEFECT_CODE } from '../../shared/codes/index.js';
import { runDefectRules, type DefectHarnessDeps } from '../defects/harness.js';
import { syntaxFor } from '../sync/dialect.js';

/** Stamped on every `DERIVATION_RUN` row: which code produced this answer. */
export const PIPELINE_VERSION = 'derive-v02.2';

export interface PipelineResult {
  sync_batch_id: string;
  /** UUIDv7, and the primary key of the `CURATED.DERIVATION_RUN` row. */
  run_id: string;
  backend: SqlDialect;
  geo_capability: 'full' | 'none';
  steps: string[];
  /** Steps that did not run on this backend. Empty with `geo_capability: 'full'`. */
  steps_skipped: string[];
  /** Defect codes whose input was never computed. **Not** the same as "no defect". */
  rules_not_run: string[];
  /** What a sample with no open defect was set to — `screened` or `screened_partial`. */
  clean_review_state: ReviewState;
  geo_derivation_state: GeoDerivationState;
  defects_raised: number;
  samples_screened: number;
  samples_needing_review: number;
}

export interface PipelineDeps {
  /** The warehouse or the Netlify database, behind the port. */
  snowflake: SqlClient;
  harness?: Omit<DefectHarnessDeps, 'snowflake'>;
  /**
   * Step 7's seam.
   *
   * The A7 harness (`src/server/defects/harness.ts`) still writes its findings
   * with `PARSE_JSON` + `FLATTEN` + `MERGE`, so it runs on Snowflake only. That
   * file is outside this lane's paths and the one-line widening it needs is
   * recorded in `integration/requests-a.md`; until it lands, this pipeline
   * **skips step 7 on a backend that cannot run it and says so** rather than
   * throwing halfway through or, worse, marking every sample clean without
   * having screened it.
   *
   * Supply this to run the rules through anything else — that is also how the
   * tests exercise step 8 on the Postgres path.
   */
  runRules?: (syncBatchId: string) => Promise<number>;
}

/** Defect rules whose only input is a geospatial derivation. */
const GEO_DEPENDENT_RULES = [
  DEFECT_CODE.POINT_OUTSIDE_BOUNDARY,
  DEFECT_CODE.OFFSET_EXCEEDED_NO_REASON,
];

export async function runDerivationPipeline(
  syncBatchId: string,
  deps: PipelineDeps,
): Promise<PipelineResult> {
  const sf = deps.snowflake;
  const syntax = syntaxFor(sf);
  const geospatial = sf.capabilities.geospatial;
  const geoState = geoStateForCapability(geospatial);
  const cleanState = cleanReviewStateFor(geoState);

  const runId = uuidv7();
  const startedTs = new Date().toISOString();
  const steps: string[] = [];
  const skipped: string[] = [];
  const rulesNotRun: string[] = [];

  const record = (outcome: 'ok' | 'partial' | 'failed', result: Partial<PipelineResult>) =>
    recordDerivationRun(sf, {
      run_id: runId,
      sync_batch_id: syncBatchId,
      started_ts: startedTs,
      outcome,
      geo_capability: geospatial ? 'full' : 'none',
      steps,
      steps_skipped: skipped,
      rules_not_run: rulesNotRun,
      clean_review_state: cleanState,
      geo_derivation_state: geoState,
      defects_raised: result.defects_raised ?? 0,
      samples_screened: result.samples_screened ?? 0,
      samples_needing_review: result.samples_needing_review ?? 0,
    });

  try {
    // --- Step 3. Geography. Invalid geometry degrades to a defect, never fails
    // the batch — a point with a mangled coordinate is still a bag in a box.
    if (geospatial) {
      await sf.execute(
        `UPDATE CURATED.SAMPLE_POINT
            SET GEOG = TRY_TO_GEOGRAPHY('POINT(' || LON || ' ' || LAT || ')'),
                GEOG_VALID = TRY_TO_GEOGRAPHY('POINT(' || LON || ' ' || LAT || ')') IS NOT NULL,
                LAST_UPDATED_TS = ${syntax.now}
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
    } else {
      // No PostGIS, so `GEOG_VALID` reduces to "lat/lon present and in range",
      // which is arithmetic. `GEOM_INVALID` therefore still fires on this
      // backend — unlike the two rules that need real geography. The row also
      // states, in `GEO_DERIVATION_STATE`, exactly how much was checked.
      const inRange = 'LAT >= -90 AND LAT <= 90 AND LON >= -180 AND LON <= 180';
      await sf.execute(
        `UPDATE CURATED.SAMPLE_POINT
            SET GEOG_VALID = (${inRange}),
                GEO_DERIVATION_STATE = CASE WHEN (${inRange})
                     THEN '${GEO_DERIVATION_STATE.DEFERRED_NO_GEOSPATIAL}'
                     ELSE '${GEO_DERIVATION_STATE.INVALID_GEOMETRY}' END,
                GEO_DERIVED_TS = ${syntax.now},
                LAST_UPDATED_TS = ${syntax.now}
          WHERE SYNC_BATCH_ID = ?
            AND LAT IS NOT NULL AND LON IS NOT NULL`,
        { binds: [syncBatchId] },
      );
      await sf.execute(
        `UPDATE CURATED.SAMPLE_POINT
            SET GEOG_VALID = FALSE,
                GEO_DERIVATION_STATE = '${GEO_DERIVATION_STATE.INVALID_GEOMETRY}',
                GEO_DERIVED_TS = ${syntax.now},
                LAST_UPDATED_TS = ${syntax.now}
          WHERE SYNC_BATCH_ID = ? AND (LAT IS NULL OR LON IS NULL)`,
        { binds: [syncBatchId] },
      );
    }
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
    if (geospatial) {
      await sf.execute(
        `UPDATE CURATED.SAMPLE_POINT sp
            SET BOUNDARY_ID = b.BOUNDARY_ID,
                LAST_UPDATED_TS = ${syntax.now}
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
    } else {
      // BOUNDARY_ID stays NULL, which is unambiguous only because
      // GEO_DERIVATION_STATE distinguishes "checked, inside nothing" from
      // "never checked". Raising POINT_OUTSIDE_BOUNDARY here would be a false
      // positive on every single row.
      skipped.push('point_in_polygon');
      rulesNotRun.push(DEFECT_CODE.POINT_OUTSIDE_BOUNDARY);
    }

    // --- Step 5. TRS, derived and never accepted from the device.
    //
    // Sourced from the containing boundary's canonical TRS. A PLSS reference
    // layer would be the better source and would also cover points that fall
    // outside every boundary; the layer's live table name is not settled in the
    // schema docs, so this takes the answer that is definitely available and
    // leaves the point outside a boundary with a NULL rather than a guess.
    if (geospatial) {
      await sf.execute(
        `UPDATE CURATED.SAMPLE_POINT sp
            SET TRS_CANONICAL = b.TRS_CANONICAL,
                LAST_UPDATED_TS = ${syntax.now}
           FROM CURATED.BOUNDARY b
          WHERE sp.SYNC_BATCH_ID = ?
            AND sp.BOUNDARY_ID = b.BOUNDARY_ID
            AND sp.TRS_CANONICAL IS NULL`,
        { binds: [syncBatchId] },
      );
      steps.push('trs');
    } else {
      // TRS comes from the containing boundary, so it is deferred with it.
      skipped.push('trs');
    }

    // --- Step 6. Offset and bearing from plan. One implementation, one answer.
    if (geospatial) {
      await sf.execute(
        `UPDATE CURATED.SAMPLE_POINT sp
            SET OFFSET_FROM_PLAN_M = ST_DISTANCE(sp.GEOG, pp.PLANNED_GEOG),
                BEARING_FROM_PLAN_DEG = DEGREES(
                  ST_AZIMUTH(pp.PLANNED_GEOG, sp.GEOG)
                ),
                LAST_UPDATED_TS = ${syntax.now}
           FROM CURATED.SAMPLE_PLAN_POINT pp
          WHERE sp.SYNC_BATCH_ID = ?
            AND sp.PLAN_POINT_ID = pp.PLAN_POINT_ID
            AND sp.GEOG_VALID = TRUE
            AND pp.PLANNED_GEOG IS NOT NULL`,
        { binds: [syncBatchId] },
      );
      steps.push('offset_from_plan');
    } else {
      // OFFSET_FROM_PLAN_M stays NULL, and `offset-exceeded-no-reason.ts`
      // treats NULL as `continue` — a rule that passes silently by
      // construction. That is precisely why it is named here.
      skipped.push('offset_from_plan');
      rulesNotRun.push(DEFECT_CODE.OFFSET_EXCEEDED_NO_REASON);
    }

    // --- Step 7. The server-rule defect set (A7 harness, A8 rules).
    let defectsRaised = 0;
    let ranRules = true;
    if (deps.runRules) {
      defectsRaised = await deps.runRules(syncBatchId);
    } else if (harnessRunsOn(sf)) {
      defectsRaised = await runDefectRules(syncBatchId, {
        // `DefectHarnessDeps` is still typed against `SnowflakeClient` and its
        // writer still emits PARSE_JSON/FLATTEN/MERGE. Only reached when the
        // capability check above says those work; see `runRules`.
        snowflake: sf as unknown as SnowflakeClient,
        ...(deps.harness ?? {}),
      });
    } else {
      ranRules = false;
      skipped.push('defect_rules');
    }
    if (ranRules) steps.push('defect_rules');

    // --- Step 8. Review state. Clean if no open defect, else `needs_review`.
    //
    // "Clean" is `screened` only where every server rule ran. Where the
    // geographic checks were skipped it is `screened_partial`, and the CHECK
    // constraint `SAMPLE_POINT_SCREENED_REQUIRES_GEO` enforces that rather than
    // trusting this line — see `src/shared/db/geo-assurance.ts`.
    //
    // `accepted` is an analyst's word and this never overwrites it — contract §1
    // property 5 is enforced on the write path and respected here.
    //
    // If step 7 did not run, step 8 does not run either: a review state written
    // from a screening that never happened is the exact lie the geo-assurance
    // work exists to prevent, and leaving the rows `captured` reads as
    // `awaiting_derivation` in `V_SAMPLE_GEO_ASSURANCE`, which is true.
    if (ranRules) {
      await sf.execute(
        `UPDATE CURATED.SAMPLE_POINT sp
            SET REVIEW_STATE = CASE
                  WHEN EXISTS (
                    SELECT 1 FROM CURATED.SAMPLE_DEFECT d
                     WHERE d.SAMPLE_UID = sp.SAMPLE_UID AND d.RESOLUTION_STATE = 'open'
                  ) THEN 'needs_review'
                  ELSE ?
                END,
                LAST_UPDATED_TS = ${syntax.now}
          WHERE sp.SYNC_BATCH_ID = ?
            AND COALESCE(sp.REVIEW_STATE, 'captured') NOT IN ('accepted', 'rejected')`,
        { binds: [cleanState, syncBatchId] },
      );
      steps.push('review_state');
    } else {
      skipped.push('review_state');
    }

    const counts = asObjects<{ review_state: string; n: string }>(
      await sf.execute(
        `SELECT REVIEW_STATE, COUNT(*) AS N FROM CURATED.SAMPLE_POINT
          WHERE SYNC_BATCH_ID = ? GROUP BY REVIEW_STATE`,
        { binds: [syncBatchId] },
      ),
    );
    const countOf = (state: string) =>
      Number(counts.find((c) => c.review_state === state)?.n ?? 0);

    const result: PipelineResult = {
      sync_batch_id: syncBatchId,
      run_id: runId,
      backend: sf.dialect,
      geo_capability: geospatial ? 'full' : 'none',
      steps,
      steps_skipped: skipped,
      rules_not_run: rulesNotRun,
      clean_review_state: cleanState,
      geo_derivation_state: geoState,
      defects_raised: defectsRaised,
      samples_screened: countOf(cleanState),
      samples_needing_review: countOf('needs_review'),
    };

    await record(skipped.length === 0 ? 'ok' : 'partial', result);
    return result;
  } catch (err) {
    // A failed run is recorded before it is rethrown. A batch whose derivation
    // died halfway is exactly what the nightly sweep looks for, and it should
    // not have to infer that from the absence of a row.
    await record('failed', {});
    throw err;
  }
}

/**
 * Whether the A7 defect harness's writer can run on this backend.
 *
 * It emits `PARSE_JSON` + `TABLE(FLATTEN(...))` + `MERGE INTO`, so it needs both
 * capabilities. Delete this the moment the harness takes a `SqlClient`.
 */
export function harnessRunsOn(db: SqlClient): boolean {
  return db.capabilities.variantJson && db.capabilities.mergeInto;
}

interface DerivationRunRow {
  run_id: string;
  sync_batch_id: string;
  started_ts: string;
  outcome: 'ok' | 'partial' | 'failed';
  geo_capability: 'full' | 'none';
  steps: string[];
  steps_skipped: string[];
  rules_not_run: string[];
  clean_review_state: string;
  geo_derivation_state: string;
  defects_raised: number;
  samples_screened: number;
  samples_needing_review: number;
}

/**
 * Backends whose DDL defines `CURATED.DERIVATION_RUN`.
 *
 * The table is new in `postgres_sampling_v01.sql` and has no Snowflake
 * counterpart yet; writing to it there would fail every run with an
 * object-not-found. A Snowflake counterpart is requested in
 * `integration/requests-a.md` — when it lands, delete this set.
 */
const DERIVATION_RUN_BACKENDS: ReadonlySet<SqlDialect> = new Set<SqlDialect>(['postgres']);

/**
 * One row per pipeline run per batch — the batch-level record of what was
 * skipped, which survives a later re-derivation that overwrites the per-row
 * `GEO_DERIVATION_STATE`.
 *
 * Append-only, never upserted: a re-run is a *new* run and the history of what
 * a given deployment could check is the point. Never fails a derivation — the
 * bookkeeping is not worth losing a batch's screening over.
 */
async function recordDerivationRun(db: SqlClient, run: DerivationRunRow): Promise<void> {
  if (!DERIVATION_RUN_BACKENDS.has(db.dialect)) return;
  try {
    await db.execute(
      `INSERT INTO CURATED.DERIVATION_RUN
         (RUN_ID, SYNC_BATCH_ID, STARTED_TS, ENDED_TS, OUTCOME, BACKEND, GEO_CAPABILITY,
          STEPS_COMPLETED, STEPS_SKIPPED, DEFECTS_RAISED, SAMPLES_SCREENED,
          SAMPLES_NEEDING_REVIEW, PIPELINE_VERSION, DETAIL_JSON)
       VALUES (?, ?, ?, ?, ?, ?, ?, (?)::jsonb, (?)::jsonb, ?, ?, ?, ?, (?)::jsonb)`,
      {
        binds: [
          run.run_id,
          run.sync_batch_id,
          run.started_ts,
          new Date().toISOString(),
          run.outcome,
          db.dialect,
          run.geo_capability,
          JSON.stringify(run.steps),
          JSON.stringify(run.steps_skipped),
          run.defects_raised,
          run.samples_screened,
          run.samples_needing_review,
          PIPELINE_VERSION,
          JSON.stringify({
            rules_not_run: run.rules_not_run,
            clean_review_state: run.clean_review_state,
            geo_derivation_state: run.geo_derivation_state,
          }),
        ],
      },
    );
  } catch (err) {
    console.error('derivation run record failed', run.sync_batch_id, run.run_id, err);
  }
}

/**
 * Raises one defect per row a query returns, idempotently.
 *
 * The trick that makes re-running safe is the **deterministic defect id**:
 * `MD5(sample_uid || '|' || defect_code)`. Re-running the pipeline over a batch
 * updates the same row rather than raising a second one, which is what v02 §11
 * criterion 3 — *exactly one defect row* — actually requires once the nightly
 * sweep can re-kick a batch. That property is the id, not the statement: it
 * survives the `MERGE` → `ON CONFLICT` rewrite unchanged, on the same id, and
 * `MD5()` renders identically on both backends.
 *
 * `VISIBLE_TO_FIELD` comes from `REF.DEFECT_FIELD_VISIBILITY` (addendum §4.2),
 * defaulting closed. A crew's list should contain only what a crew can act on.
 *
 * @param selectSql must yield `SAMPLE_UID` and `DETAIL`, and must contain
 *   exactly one `?` for the batch id. Binds are positional, so that placeholder
 *   sits fourth in the array below — between the severity and the two
 *   reference-table joins. The order is identical on both backends.
 */
export async function raiseDefectFromQuery(
  sf: SqlClient,
  defectCode: string,
  severity: string,
  selectSql: string,
  syncBatchId: string,
): Promise<void> {
  const syntax = syntaxFor(sf);
  const binds = [defectCode, defectCode, severity, syncBatchId, defectCode, defectCode];

  if (sf.dialect === 'postgres') {
    await sf.execute(
      `INSERT INTO CURATED.SAMPLE_DEFECT AS t
         (DEFECT_ID, SAMPLE_UID, DEFECT_CODE, SEVERITY, DETECTED_BY,
          DETECTED_TS, DETAIL, RESOLUTION_STATE, VISIBLE_TO_FIELD)
       SELECT s.DEFECT_ID, s.SAMPLE_UID, s.DEFECT_CODE, s.SEVERITY, 'server_rule',
              ${syntax.now}, s.DETAIL, 'open', s.VISIBLE_TO_FIELD
         FROM (
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
          ON CONFLICT (DEFECT_ID) DO UPDATE SET
             DETAIL = EXCLUDED.DETAIL,
             SEVERITY = EXCLUDED.SEVERITY,
             VISIBLE_TO_FIELD = EXCLUDED.VISIBLE_TO_FIELD,
             LAST_UPDATED_TS = ${syntax.now}
           WHERE t.RESOLUTION_STATE = 'open'`,
      { binds },
    );
    return;
  }

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
           LAST_UPDATED_TS = ${syntax.now}
      WHEN NOT MATCHED THEN
           INSERT (DEFECT_ID, SAMPLE_UID, DEFECT_CODE, SEVERITY, DETECTED_BY,
                   DETECTED_TS, DETAIL, RESOLUTION_STATE, VISIBLE_TO_FIELD)
           VALUES (s.DEFECT_ID, s.SAMPLE_UID, s.DEFECT_CODE, s.SEVERITY, 'server_rule',
                   ${syntax.now}, s.DETAIL, 'open', s.VISIBLE_TO_FIELD)`,
    { binds },
  );
}
