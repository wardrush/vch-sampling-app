/**
 * The server-rule defect set. Contract §6 step 7.
 *
 * **A8 (Lane A, tagged [HAIKU]) owns the individual rules.** Each is a pure
 * function with a fixture — exactly the shape v02 Appendix A puts in the cheap
 * tier, *once the harness exists*. The harness now exists.
 *
 * Two rules are implemented here rather than left to A8, because v02 §11
 * criterion 3 is an Opus-owned acceptance test (A13) and it needs something
 * real to assert against: a duplicate barcode and a missing GPS fix. They are
 * also the reference implementations — a new rule should read like these.
 *
 * `PENDING_A8_RULES` names what is still outstanding. `rules.registry.test.ts`
 * asserts that every code in the contract's step-7 list is either implemented
 * or listed there, so a rule cannot go missing quietly.
 */

import type { DefectRule } from '../types.js';
import { DEFECT_CODE } from '../../../shared/codes/index.js';
import { duplicateBarcodeRule } from './duplicate-barcode.js';
import { noGpsFixRule } from './no-gps-fix.js';

export function defaultRules(): DefectRule[] {
  return [duplicateBarcodeRule, noGpsFixRule];
}

/** Owned by A8. Named, so the gap is visible rather than discovered in April. */
export const PENDING_A8_RULES: readonly string[] = [
  DEFECT_CODE.MISSING_REQUIRED_MEDIA,
  DEFECT_CODE.OFFSET_EXCEEDED_NO_REASON,
  DEFECT_CODE.CLOCK_DRIFT_SUSPECTED,
  DEFECT_CODE.EXIF_POSITION_MISMATCH,
  DEFECT_CODE.MEDIA_GALLERY_SOURCED,
  DEFECT_CODE.DEPTH_SHORTFALL,
];

/**
 * Codes raised by the pipeline itself rather than by a rule, because they are
 * decided by a spatial operation the warehouse performs (§6 steps 3–4).
 */
export const PIPELINE_RAISED: readonly string[] = [
  DEFECT_CODE.POINT_OUTSIDE_BOUNDARY,
  DEFECT_CODE.GEOM_INVALID,
];

/** `PLAN_POINT_UNSAMPLED` is a sweep over a *closed plan*, not over a batch (A9). */
export const NIGHTLY_RAISED: readonly string[] = [DEFECT_CODE.PLAN_POINT_UNSAMPLED];

export { duplicateBarcodeRule, noGpsFixRule };
