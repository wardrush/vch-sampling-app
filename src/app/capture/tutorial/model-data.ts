/**
 * The tutorial's model data (plan v02 D18: "model data with deliberate,
 * instructive faults").
 *
 * Everything here is invented and says so. The plan point is a real-looking
 * point in North Dakota that does not exist, the property name is not a
 * customer, and every identifier carries the reserved `tutorial-` prefix from
 * `tutorial-boundary.ts` — so if any of it ever reaches `writeCaptureLocally`
 * the write throws instead of succeeding.
 *
 * **The thresholds are the one thing that should not be model data.** A
 * tutorial that teaches a 10 m accuracy target when the project's spec says 7
 * has taught the wrong number, and the sampler will not re-learn it. So
 * `createTutorialCaptureSession` takes an optional real `CaptureSpec` from the
 * assignment bundle and uses it when the caller has one; `TUTORIAL_SPEC` below
 * is the fallback for a first run on a device that has not synced a bundle yet,
 * which is precisely when a first-run tutorial happens.
 */

import type { CaptureSpec } from '../session.js';
import { TUTORIAL_ID_PREFIX } from '../tutorial-boundary.js';

export interface TutorialPlanPoint {
  plan_point_id: string;
  plan_point_label: string;
  planned_lat: number;
  planned_lon: number;
  strata_label: string;
  property_name: string;
  boundary_id: string;
}

/**
 * Field 3, point PT-001. Deliberately about 18 m from where the simulated
 * receiver settles, which is past `max_plan_offset_m_warn` and short of
 * `max_plan_offset_m_block` — so the offset chip goes amber and the deviation
 * picker appears without the tutorial being unable to finish. That is the
 * "deliberate, instructive fault" D18 asks for: the sampler meets the amber
 * state once, here, instead of for the first time in a field.
 */
export const TUTORIAL_PLAN_POINT: TutorialPlanPoint = {
  plan_point_id: `${TUTORIAL_ID_PREFIX}point-PT-001`,
  plan_point_label: 'PT-001 (example)',
  planned_lat: 47.5432,
  planned_lon: -99.1234,
  strata_label: 'D1_Clay Loam',
  property_name: 'Example Farm — tutorial data',
  boundary_id: `${TUTORIAL_ID_PREFIX}boundary-example`,
};

/**
 * Fallback thresholds only. These match `fixtures/bundle.f26-demo.json`, which
 * is itself the demo project's spec — not a number anybody invented in this
 * file, and not a number the production path will ever read.
 */
export const TUTORIAL_SPEC: CaptureSpec = {
  spec_id: `${TUTORIAL_ID_PREFIX}spec-example`,
  period_code: 'F26',
  protocol_version: 'BCARBON_V3.0',
  required_media_roles: ['label_photo', 'core_photo', 'site_photo'],
  gps_accuracy_required_m: 10,
  min_gps_fix_count: 3,
  max_plan_offset_m_warn: 15,
  max_plan_offset_m_block: 30,
};

/**
 * The receiver's track, replayed by `scripted-gps.ts`.
 *
 * A cold start that is honest about being one: the first fix is a 42 m
 * network-derived position 30 m off, then GNSS settles. `GpsAcquisition`
 * excludes nothing here (its ceiling is 100 m) but weights the 42 m fix at
 * about a fortieth of the 4 m one, so the estimate walks in — and the accuracy
 * chip crosses the spec threshold live, which is the thing the tutorial is
 * trying to show. The first fix stays in `fix_samples_json`; nothing is
 * discarded.
 */
export const TUTORIAL_GPS_TRACK: ReadonlyArray<{
  lat: number;
  lon: number;
  accuracy_m: number;
  altitude_m: number;
  altitude_accuracy_m: number;
  after_ms: number;
}> = [
  { lat: 47.54295, lon: -99.124, accuracy_m: 42, altitude_m: 604, altitude_accuracy_m: 30, after_ms: 400 },
  { lat: 47.54324, lon: -99.1237, accuracy_m: 14, altitude_m: 609, altitude_accuracy_m: 12, after_ms: 1200 },
  { lat: 47.54328, lon: -99.12362, accuracy_m: 7, altitude_m: 610, altitude_accuracy_m: 8, after_ms: 2000 },
  { lat: 47.54329, lon: -99.1236, accuracy_m: 5, altitude_m: 610, altitude_accuracy_m: 7, after_ms: 2800 },
  { lat: 47.5433, lon: -99.12359, accuracy_m: 4, altitude_m: 611, altitude_accuracy_m: 6, after_ms: 3600 },
];
