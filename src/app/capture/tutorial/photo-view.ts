/**
 * One place that turns a photograph — of either kind — into what a tile shows.
 *
 * This exists so that a screen rendering a photo tile can never be the thing
 * that decides how a capture source is described to a human. Requirement 3 of
 * the tutorial-photo brief is that a viewer can see the photograph is
 * illustrative, and "the screen remembered to add a badge" is the version of
 * that requirement which fails silently the first time someone writes a second
 * tile component.
 *
 * The function is total over both photo types, and the discriminant is the
 * `capture_source` the intake minted — not a flag a caller passes in. There is
 * no argument to this function that makes a tutorial photograph render as a
 * camera one.
 */

import type { AttachedPhoto } from '../session.js';
import type { TutorialAttachedPhoto } from './session.js';

export interface CapturePhotoView {
  media_id: string;
  media_role: string;
  preview_url: string | null;
  bytes: number;
  width_px: number;
  height_px: number;
  /** What the tile says under the thumbnail. */
  provenance_label: string;
  /** `neutral` renders quietly; `warning` and `tutorial` must be conspicuous. */
  provenance_tone: 'neutral' | 'warning' | 'tutorial';
  is_tutorial: boolean;
}

export function capturePhotoView(
  photo: AttachedPhoto | TutorialAttachedPhoto,
): CapturePhotoView {
  const base = {
    media_id: photo.media_id,
    media_role: photo.media_role,
    preview_url: photo.preview_url,
    bytes: photo.bytes,
    width_px: photo.width_px,
    height_px: photo.height_px,
  };

  switch (photo.capture_source) {
    case 'tutorial_synthetic':
      return {
        ...base,
        provenance_label: 'TUTORIAL — synthetic image, not evidence',
        provenance_tone: 'tutorial',
        is_tutorial: true,
      };
    case 'device_gallery':
      return {
        ...base,
        // Permanently marked (addendum §3.1). The wording says "marked"
        // rather than "unverified" because the record is not in doubt — the
        // provenance is known and it is the wrong one for a required role.
        provenance_label: 'From gallery — marked, cannot satisfy a required role',
        provenance_tone: 'warning',
        is_tutorial: false,
      };
    case 'in_app_camera':
      return {
        ...base,
        provenance_label: 'In-app camera',
        provenance_tone: 'neutral',
        is_tutorial: false,
      };
    default:
      // `'unknown'` — a media row the app did not create. Never produced by
      // either session in this directory; handled so the switch is total.
      return {
        ...base,
        provenance_label: 'Source unknown',
        provenance_tone: 'warning',
        is_tutorial: false,
      };
  }
}
