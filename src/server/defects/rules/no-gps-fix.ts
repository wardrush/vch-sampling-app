/**
 * `NO_GPS_FIX` and `GPS_ACCURACY_EXCEEDED`.
 *
 * Reference implementation for A8, and the one that shows why
 * `position_source` was worth a column. Three cases that look alike in a table
 * of numbers and are not alike at all:
 *
 *   - **no coordinate** — nothing was captured. Blocking.
 *   - **a dropped map pin** — a coordinate exists, but nobody's receiver saw a
 *     satellite. It is not a fix, it is a claim about where someone stood, and
 *     it is read in 2029 as such.
 *   - **a fix that missed the spec's accuracy or fix-count gate** — real, but
 *     weaker than the protocol asks for.
 *
 * The spec's own thresholds are used where present; a sample with no resolvable
 * spec is only checked for the first case, because inventing a threshold is
 * worse than not applying one.
 */

import { DEFECT_CODE } from '../../../shared/codes/index.js';
import type { DefectFinding, DefectRule, RuleContext } from '../types.js';

export const noGpsFixRule: DefectRule = {
  code: DEFECT_CODE.NO_GPS_FIX,
  description: 'No satellite fix was recorded for this point',

  run(ctx: RuleContext): DefectFinding[] {
    const findings: DefectFinding[] = [];

    for (const sample of ctx.samples) {
      if (sample.lat === null || sample.lon === null) {
        findings.push({
          sample_uid: sample.sample_uid,
          defect_code: DEFECT_CODE.NO_GPS_FIX,
          severity: 'blocking',
          detail: 'no coordinate was recorded for this sample',
        });
        continue;
      }

      if (sample.position_source === 'manual_map_pin') {
        findings.push({
          sample_uid: sample.sample_uid,
          defect_code: DEFECT_CODE.NO_GPS_FIX,
          severity: 'blocking',
          detail: 'position came from a dropped map pin, not a satellite fix',
        });
        continue;
      }

      const spec = sample.spec_id ? ctx.specs.get(sample.spec_id) : undefined;
      if (!spec) continue;

      const required = spec.gps_accuracy_required_m;
      if (required !== null && sample.gps_accuracy_m !== null && sample.gps_accuracy_m > required) {
        findings.push({
          sample_uid: sample.sample_uid,
          defect_code: DEFECT_CODE.GPS_ACCURACY_EXCEEDED,
          severity: 'review',
          detail: `accuracy ${sample.gps_accuracy_m} m exceeds the spec's ${required} m`,
        });
        continue;
      }

      const minFixes = spec.min_gps_fix_count;
      if (minFixes !== null && sample.fix_count !== null && sample.fix_count < minFixes) {
        findings.push({
          sample_uid: sample.sample_uid,
          defect_code: DEFECT_CODE.GPS_ACCURACY_EXCEEDED,
          severity: 'review',
          detail: `${sample.fix_count} fixes averaged, spec asks for ${minFixes}`,
        });
      }
    }
    return findings;
  },
};
