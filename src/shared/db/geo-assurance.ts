/**
 * Geospatial assurance state — "not checked" vs "checked and passed".
 *
 * ## The failure this exists to prevent
 *
 * Two defect rules are computations over geography: `POINT_OUTSIDE_BOUNDARY`
 * (from `ST_WITHIN`) and `OFFSET_EXCEEDED_NO_REASON` (from `ST_DISTANCE`, via
 * `SAMPLE_POINT.OFFSET_FROM_PLAN_M`). On the Postgres backend there is no
 * PostGIS, so neither computation runs.
 *
 * If nothing records that, the derivation pipeline finishes, no defect is
 * raised, and every sample reads `review_state = 'screened'`. A tester
 * concludes defect detection works. An auditor in 2029 cannot tell an unchecked
 * sample from a checked-and-clean one — and the offset rule fails *silently*
 * today, by design: `offset_from_plan_m === null` is a `continue`, not an error
 * (`src/server/defects/rules/offset-exceeded-no-reason.ts`).
 *
 * That is the worst outcome available here and it is worse than the feature
 * being missing. So the absence is recorded in the data.
 *
 * ## The design, in three parts
 *
 * 1. **`SAMPLE_POINT.GEO_DERIVATION_STATE`** — `NOT NULL DEFAULT 'pending'`.
 *    Every row says which geographic derivation it actually received. A NULL
 *    `boundary_id` is no longer ambiguous: paired with `derived_geodesic` it is
 *    a *positive finding* ("checked; inside no active boundary"), paired with
 *    `deferred_no_geospatial` it is *unknown*.
 * 2. **`CURATED.DERIVATION_RUN`** — one row per pipeline run per batch,
 *    recording the backend, its geospatial capability, and the steps skipped.
 *    Batch-level, so the question survives a later re-derivation of the rows.
 * 3. **A CHECK constraint with teeth.** `review_state = 'screened'` is not
 *    permitted unless `geo_derivation_state` is one of the derived values. A
 *    sample on the Postgres backend that passed every runnable rule reaches
 *    `screened_partial`, never `screened`. The constraint means the Postgres
 *    path *cannot* claim a full pass it did not perform — it fails at the
 *    INSERT, in a test, in the first hour, rather than in an audit in 2029.
 *
 * The DDL is `postgres_sampling_v01.sql`. The constants here and the CHECK
 * constraints there are two halves of one decision; keep them in step.
 */

/** How much geographic derivation a `SAMPLE_POINT` row actually received. */
export const GEO_DERIVATION_STATE = {
  /** Row landed; the geography step has not run yet. The default. */
  PENDING: 'pending',
  /** Full `ST_*` derivation on a geospatial backend. The production answer. */
  DERIVED_GEODESIC: 'derived_geodesic',
  /**
   * Computed in application code from GeoJSON — planar ray-casting for
   * containment, haversine for distance (`src/shared/geo/**`, which already has
   * both). Reserved: **nothing sets this yet.** It exists so that lifting the
   * deferral later is a code change and not a migration, and so the resulting
   * rows are never mistaken for the geodesic answer, which they are not: planar
   * containment and geodesic `ST_WITHIN` disagree at boundary edges.
   */
  DERIVED_PLANAR: 'derived_planar',
  /**
   * The backend has no geospatial capability. Explicitly **not checked**.
   * `boundary_id`, `offset_from_plan_m`, `bearing_from_plan_deg` and
   * `trs_canonical` are unknown on this row, not absent.
   */
  DEFERRED_NO_GEOSPATIAL: 'deferred_no_geospatial',
  /** Lat/lon missing or out of range. Checked, and the coordinate is bad. */
  INVALID_GEOMETRY: 'invalid_geometry',
} as const;

export type GeoDerivationState =
  (typeof GEO_DERIVATION_STATE)[keyof typeof GEO_DERIVATION_STATE];

/** The states that count as "the geographic checks actually ran". */
export const GEO_VERIFIED_STATES: readonly GeoDerivationState[] = [
  GEO_DERIVATION_STATE.DERIVED_GEODESIC,
  GEO_DERIVATION_STATE.DERIVED_PLANAR,
];

/**
 * True when the geographic derivations ran on this row.
 *
 * `invalid_geometry` is deliberately **not** verified: a bad coordinate means
 * containment and offset were never evaluated either, so claiming otherwise
 * would re-introduce exactly the ambiguity this module removes.
 */
export function isGeoVerified(state: string | null | undefined): boolean {
  return GEO_VERIFIED_STATES.includes(state as GeoDerivationState);
}

/**
 * Review states. `screened_partial` is new in this pass.
 *
 * `screened` means *every* server rule ran and found nothing. On a backend
 * without geospatial, that sentence is false, so the terminal clean state is
 * `screened_partial` — which reads correctly to an analyst and to an auditor,
 * and which the DDL enforces.
 */
export const REVIEW_STATE = {
  CAPTURED: 'captured',
  /** Every server rule ran and found nothing. Requires a verified geo state. */
  SCREENED: 'screened',
  /** Every *runnable* rule found nothing, but some rules could not run. */
  SCREENED_PARTIAL: 'screened_partial',
  NEEDS_REVIEW: 'needs_review',
  /** An analyst's word. Never written by the pipeline. */
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
} as const;

export type ReviewState = (typeof REVIEW_STATE)[keyof typeof REVIEW_STATE];

/**
 * The clean terminal state for a sample, given what actually ran.
 *
 * The one function the derivation pipeline needs from this module. Written here
 * rather than inline in the pipeline's `CASE` expression so that the rule and
 * the CHECK constraint that enforces it live next to each other.
 */
export function cleanReviewStateFor(geoState: string | null | undefined): ReviewState {
  return isGeoVerified(geoState) ? REVIEW_STATE.SCREENED : REVIEW_STATE.SCREENED_PARTIAL;
}

/** What a backend's `capabilities.geospatial` implies for a freshly derived row. */
export function geoStateForCapability(geospatial: boolean): GeoDerivationState {
  return geospatial
    ? GEO_DERIVATION_STATE.DERIVED_GEODESIC
    : GEO_DERIVATION_STATE.DEFERRED_NO_GEOSPATIAL;
}
