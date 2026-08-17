/**
 * B8 — media intake, and the enforcement of `capture_source`.
 *
 * The two intake paths are the only ways to produce an image, and they produce
 * different types. `attachRequiredRole` accepts `CameraImage` and nothing else,
 * so the gallery path cannot reach a required role — not "is rejected when it
 * tries", *cannot*.
 *
 * Why this is worth a branded type rather than an `if`: the requirement is
 * read in 2029 by someone deciding whether a credit is real. "The app validated
 * it" is a claim about a build that shipped three years earlier. "The type did
 * not exist" is a claim about the source, and the source is in the repository.
 */

import { uuidv7 } from 'uuidv7';
import type { MediaMetaPayload } from '../../../shared/contract/entities.js';
import type {
  CameraImage,
  GalleryImage,
  IntakeImage,
  OptionalMediaRole,
  RequiredMediaRole,
} from './types.js';
import { isRequiredRole } from './types.js';
import { processImage, type ProcessOptions } from './pipeline.js';

/**
 * Bytes from the in-app camera.
 *
 * The caller must have obtained them from a live `getUserMedia` stream or a
 * `capture="environment"` input. That is a claim this function cannot verify —
 * the platform gives no proof of origin — so it is asserted in exactly one
 * place, here, rather than in each of the six call sites that attach a photo.
 */
export async function intakeFromCamera(
  bytes: Uint8Array,
  options: ProcessOptions,
): Promise<CameraImage> {
  const processed = await processImage(bytes, options);
  return { ...processed, capture_source: 'in_app_camera' };
}

/** Bytes the sampler picked from the camera roll. Permanently marked. */
export async function intakeFromGallery(
  bytes: Uint8Array,
  options: ProcessOptions,
): Promise<GalleryImage> {
  const processed = await processImage(bytes, options);
  return { ...processed, capture_source: 'device_gallery' };
}

export interface AttachContext {
  sample_uid?: string | null;
  bag_id?: string | null;
  visit_id?: string | null;
  device_id: string | null;
  capture_order?: number | null;
  captured_ts_device?: string | null;
}

/**
 * Attaches an in-app-camera image to a required role.
 *
 * The signature is the guarantee. The runtime check below is for JavaScript
 * callers and for the day someone reaches for `as`.
 */
export function attachRequiredRole(
  role: RequiredMediaRole,
  image: CameraImage,
  context: AttachContext,
): MediaMetaPayload {
  if (image.capture_source !== 'in_app_camera') {
    throw new Error(
      `required role ${role} accepts in-app camera images only; got ${String(
        (image as IntakeImage).capture_source,
      )}`,
    );
  }
  return toPayload(role, image, context, true);
}

/** Attaches either kind to an optional role. Gallery origin is preserved. */
export function attachOptionalRole(
  role: OptionalMediaRole,
  image: IntakeImage,
  context: AttachContext,
): MediaMetaPayload {
  return toPayload(role, image, context, false);
}

/**
 * The one dynamic entry point, for a UI that resolves the role at runtime.
 *
 * Returns a discriminated result rather than throwing, because the caller is a
 * screen and the answer is a message next to a tile, not an exception.
 */
export type AttachOutcome =
  | { ok: true; media: MediaMetaPayload }
  | { ok: false; reason: 'gallery_not_allowed_for_required_role' };

export function attachToRole(
  role: RequiredMediaRole | OptionalMediaRole,
  image: IntakeImage,
  context: AttachContext,
): AttachOutcome {
  if (isRequiredRole(role)) {
    if (image.capture_source !== 'in_app_camera') {
      return { ok: false, reason: 'gallery_not_allowed_for_required_role' };
    }
    return { ok: true, media: attachRequiredRole(role, image, context) };
  }
  return { ok: true, media: attachOptionalRole(role, image, context) };
}

function toPayload(
  role: string,
  image: IntakeImage,
  context: AttachContext,
  isRequired: boolean,
): MediaMetaPayload {
  return {
    media_id: uuidv7(),
    content_hash: image.content_hash,
    sample_uid: context.sample_uid ?? null,
    bag_id: context.bag_id ?? null,
    visit_id: context.visit_id ?? null,
    media_role: role as MediaMetaPayload['media_role'],
    is_required_role: isRequired,
    capture_order: context.capture_order ?? null,
    capture_ts_device: context.captured_ts_device ?? new Date().toISOString(),
    exif_lat: image.exif_lat,
    exif_lon: image.exif_lon,
    exif_ts: image.exif_ts,
    exif_raw: image.exif_raw,
    exif_gps_present: image.exif_gps_present,
    bytes: image.byte_length,
    width_px: image.width_px,
    height_px: image.height_px,
    mime_type: image.mime_type,
    capture_source: image.capture_source,
    device_id: context.device_id,
  };
}

/** Which required roles a sample still owes, for the three role tiles. */
export function missingRequiredRoles(
  requiredRoles: readonly string[],
  attached: readonly Pick<MediaMetaPayload, 'media_role' | 'capture_source'>[],
): string[] {
  const satisfied = new Set(
    attached
      .filter((m) => m.capture_source === 'in_app_camera')
      .map((m) => m.media_role as string),
  );
  return requiredRoles.filter((role) => !satisfied.has(role));
}
