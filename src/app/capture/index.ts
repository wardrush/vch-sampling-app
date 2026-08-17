/**
 * The capture path's public surface. **Screens import from here and nowhere
 * else under `src/app/capture/`.**
 *
 * That is not a style preference. `camera/intake.ts` exposes
 * `intakeFromCamera(bytes, …)`, which stamps `capture_source: 'in_app_camera'`
 * on whatever bytes it is handed — it is the one place in the codebase where
 * that claim is asserted rather than derived, and its own header says so. It
 * is not re-exported here, and `structural-guarantee.test.ts` fails the build
 * if anything outside `src/app/capture/` imports it directly. A screen that
 * reached past this barrel could hand a picked file to a required role, which
 * is precisely the thing v02 §11 criterion 11 forbids.
 *
 * Everything a screen legitimately needs is below.
 */

export {
  CaptureSession,
  createCaptureSession,
  type AttachedPhoto,
  type CaptureAdvisory,
  type CaptureSaveInput,
  type CaptureSaveResult,
  type CaptureSessionOptions,
  type CaptureSessionState,
  type CaptureSpec,
  type CapturePhotoOutcome,
  type PhotoRefusalReason,
} from './session.js';

export {
  GpsAcquisition,
  advisoryOffsetFromPlan,
  manualPinCapture,
  type GeolocationLike,
  type GpsCaptureResult,
  type GpsCaptureSpec,
  type GpsFix,
  type GpsState,
} from './gps.js';

export {
  CameraUnavailableError,
  LiveCameraSource,
  type CameraFrame,
  type CameraSource,
  type CameraStatus,
  type CameraUnavailableReason,
} from './camera/source.js';

export {
  REQUIRED_ROLES,
  isRequiredRole,
  type OptionalMediaRole,
  type RequiredMediaRole,
} from './camera/types.js';

export { missingRequiredRoles } from './camera/intake.js';

export { browserImaging, exifrParser } from './camera/imaging.js';
export { JPEG_QUALITY, LONG_EDGE_PX, targetSize } from './camera/pipeline.js';

export {
  MemoryMediaBlobStore,
  OpfsMediaBlobStore,
  mediaLocalPath,
  objectUrlFor,
  revokeObjectUrl,
  type MediaBlobStore,
} from './media-blobs.js';

export { writeCaptureLocally, type CaptureWrite, type StoredMedia } from './save.js';
