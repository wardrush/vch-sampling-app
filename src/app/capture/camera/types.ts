/**
 * B8 — the type-level half of the `capture_source` guarantee.
 *
 * v02 §11 criterion 11: *a photograph selected from the gallery cannot satisfy
 * a required photo role, and is permanently marked when attached to an optional
 * one.*
 *
 * "Cannot" is the operative word. Validating after the fact would satisfy the
 * sentence and miss the point — the plan asks for required roles to be
 * **structurally incapable** of accepting a gallery photo. So the two intake
 * paths produce two different types, and the function that attaches a required
 * role accepts only one of them. Passing a gallery image to a required role is
 * a compile error, not a runtime rejection.
 *
 * The runtime check and the server-side `MEDIA_GALLERY_SOURCED` rule both still
 * exist, because the app is not the only thing that can write a media row. Three
 * layers, and the innermost one is the type system.
 */

import type { CaptureSource, MediaRole } from '../../../shared/contract/common.js';

/** Roles that are evidence of having been at the hole. */
export type RequiredMediaRole = 'label_photo' | 'core_photo' | 'site_photo';

/** Roles where a gallery image is legitimate — and permanently marked. */
export type OptionalMediaRole = 'issue_photo' | 'other';

export const REQUIRED_ROLES: readonly RequiredMediaRole[] = [
  'label_photo',
  'core_photo',
  'site_photo',
];

export function isRequiredRole(role: MediaRole): role is RequiredMediaRole {
  return (REQUIRED_ROLES as readonly string[]).includes(role);
}

export interface ProcessedImage {
  bytes: Uint8Array;
  /** Bare hex SHA-256 of `bytes`. Addresses the object store. */
  content_hash: string;
  width_px: number;
  height_px: number;
  mime_type: string;
  byte_length: number;
  exif_lat: number | null;
  exif_lon: number | null;
  exif_ts: string | null;
  /** Preserved verbatim. Independent corroboration of the app's own fix. */
  exif_raw: unknown;
  exif_gps_present: boolean;
}

/**
 * An image from the in-app camera. The only type a required role accepts.
 *
 * The literal `capture_source` is what makes the two branded types
 * incompatible; there is no cast in this codebase that produces one from the
 * other, and adding one would be the whole bug.
 */
export interface CameraImage extends ProcessedImage {
  readonly capture_source: Extract<CaptureSource, 'in_app_camera'>;
}

/** An image the sampler picked from the camera roll. */
export interface GalleryImage extends ProcessedImage {
  readonly capture_source: Extract<CaptureSource, 'device_gallery'>;
}

export type IntakeImage = CameraImage | GalleryImage;
