/**
 * `MISSING_REQUIRED_MEDIA` — a required photo role is not present on this sample.
 *
 * The spec defines which photo roles are required (e.g. label_photo, core_photo,
 * site_photo). If a sample is missing any of them, it is flagged. Note that a
 * role can have multiple photos; the flag fires only if the count is zero.
 */

import { DEFECT_CODE } from '../../../shared/codes/index.js';
import type { DefectFinding, DefectRule, RuleContext } from '../types.js';

export const missingRequiredMediaRule: DefectRule = {
  code: DEFECT_CODE.MISSING_REQUIRED_MEDIA,
  description: 'A required photo role is not present for this sample',

  run(ctx: RuleContext): DefectFinding[] {
    const findings: DefectFinding[] = [];

    for (const sample of ctx.samples) {
      // Find the spec for this sample
      const spec = sample.spec_id ? ctx.specs.get(sample.spec_id) : undefined;
      if (!spec || !spec.required_media_roles || spec.required_media_roles.length === 0) {
        continue;
      }

      // Check which required roles are present for this sample
      const mediaForSample = ctx.media.filter((m) => m.sample_uid === sample.sample_uid);
      const presentRoles = new Set(mediaForSample.map((m) => m.media_role));

      // Find missing required roles
      for (const requiredRole of spec.required_media_roles) {
        if (!presentRoles.has(requiredRole)) {
          findings.push({
            sample_uid: sample.sample_uid,
            defect_code: DEFECT_CODE.MISSING_REQUIRED_MEDIA,
            severity: 'blocking',
            detail: `required photo role '${requiredRole}' is not present`,
          });
        }
      }
    }

    return findings;
  },
};
