/**
 * `MEDIA_GALLERY_SOURCED` — a required photo role was supplied from the device
 * gallery, not the in-app camera.
 *
 * A photograph picked from the device's existing photo gallery is not evidence
 * of having been at the hole at the moment of sampling. The app should prevent
 * gallery selection for required roles; this rule catches the case where it did
 * not — office-only, because a crew cannot fix a photo that is already attached.
 */

import { DEFECT_CODE } from '../../../shared/codes/index.js';
import type { DefectFinding, DefectRule, RuleContext } from '../types.js';

export const mediaGallerySourcedRule: DefectRule = {
  code: DEFECT_CODE.MEDIA_GALLERY_SOURCED,
  description: 'Required photo came from the device gallery, not the in-app camera',

  run(ctx: RuleContext): DefectFinding[] {
    const findings: DefectFinding[] = [];

    for (const media of ctx.media) {
      // Only check required roles from samples
      if (!media.is_required_role || !media.sample_uid) continue;

      // Flag if the photo came from the device gallery
      if (media.capture_source === 'device_gallery') {
        findings.push({
          sample_uid: media.sample_uid,
          defect_code: DEFECT_CODE.MEDIA_GALLERY_SOURCED,
          severity: 'review',
          detail: `required photo role '${media.media_role}' came from the device gallery, not the in-app camera`,
        });
      }
    }

    return findings;
  },
};
