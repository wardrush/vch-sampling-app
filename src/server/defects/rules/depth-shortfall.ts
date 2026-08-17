/**
 * `DEPTH_SHORTFALL` — the recorded depth is less than the spec's required depth.
 *
 * The spec defines `DEPTH_BOTTOM_CM`: the minimum depth at which a sample must
 * be taken (e.g., 30 cm for a 0–30 cm interval). If `depth_achieved_cm` is
 * recorded and falls short of this, it is flagged. `NULL` means "per the spec",
 * which is the normal case and costs the sampler nothing.
 */

import { DEFECT_CODE } from '../../../shared/codes/index.js';
import type { DefectFinding, DefectRule, RuleContext } from '../types.js';

export const depthShortfallRule: DefectRule = {
  code: DEFECT_CODE.DEPTH_SHORTFALL,
  description: 'Recorded depth falls short of the protocol requirement',

  run(ctx: RuleContext): DefectFinding[] {
    const findings: DefectFinding[] = [];

    for (const sample of ctx.samples) {
      // Only check when depth was actually recorded as an exception
      if (sample.depth_achieved_cm === null) continue;

      // Find the spec for this sample
      const spec = sample.spec_id ? ctx.specs.get(sample.spec_id) : undefined;
      if (!spec || spec.depth_bottom_cm === null) continue;

      // Flag if achieved depth is less than the required bottom depth
      if (sample.depth_achieved_cm < spec.depth_bottom_cm) {
        findings.push({
          sample_uid: sample.sample_uid,
          defect_code: DEFECT_CODE.DEPTH_SHORTFALL,
          severity: 'review',
          detail: `depth achieved ${sample.depth_achieved_cm} cm is less than the spec's minimum ${spec.depth_bottom_cm} cm`,
        });
      }
    }

    return findings;
  },
};
