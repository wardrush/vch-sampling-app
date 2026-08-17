/**
 * `OFFSET_EXCEEDED_NO_REASON` — the sample is beyond the plan point's block
 * threshold but the sampler did not record a deviation reason.
 *
 * The spec defines `MAX_PLAN_OFFSET_M_BLOCK`: if a sample is farther than this
 * distance from the plan point, it *requires* a deviation reason to explain why.
 * This rule fires when that condition is violated — office-only, because a crew
 * cannot act on it (the reason has already not been provided).
 */

import { DEFECT_CODE } from '../../../shared/codes/index.js';
import type { DefectFinding, DefectRule, RuleContext } from '../types.js';

export const offsetExceededNoReasonRule: DefectRule = {
  code: DEFECT_CODE.OFFSET_EXCEEDED_NO_REASON,
  description: 'Sample is far from plan point but no deviation reason was recorded',

  run(ctx: RuleContext): DefectFinding[] {
    const findings: DefectFinding[] = [];

    for (const sample of ctx.samples) {
      // Need both spec and offset to check this rule
      if (sample.offset_from_plan_m === null || sample.plan_point_id === null) {
        continue;
      }

      const spec = sample.spec_id ? ctx.specs.get(sample.spec_id) : undefined;
      if (!spec) continue;

      // If no block threshold is defined, the rule does not apply
      const blockThreshold = spec.max_plan_offset_m_block;
      if (blockThreshold === null) continue;

      // If the offset exceeds the block threshold and there's no deviation reason, flag it
      if (sample.offset_from_plan_m > blockThreshold && !sample.deviation_reason_code) {
        findings.push({
          sample_uid: sample.sample_uid,
          defect_code: DEFECT_CODE.OFFSET_EXCEEDED_NO_REASON,
          severity: 'review',
          detail: `offset ${sample.offset_from_plan_m} m exceeds block threshold ${blockThreshold} m with no deviation reason`,
        });
      }
    }

    return findings;
  },
};
