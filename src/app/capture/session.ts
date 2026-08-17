/**
 * Screen 3's capture session — the object the Capture screen drives.
 *
 * `pwa-screens` owns the screen; this owns what the screen is allowed to do.
 * The split matters because every guarantee in v02 §9 is a guarantee about
 * *what happened*, and a screen is the wrong place to keep them: it re-renders,
 * it unmounts, it gets rewritten when someone changes the layout.
 *
 * What the session guarantees, and where each comes from:
 *
 *  - **GPS starts at `open()`, never at save** (v02 §3). `start()` is called
 *    from the screen's mount and `stop()` from its unmount, and there is no
 *    method that acquires a position at submit time.
 *  - **A required role can only be satisfied by a live camera frame.** There
 *    is no method on this object that takes a required role and a file. The
 *    gallery method's parameter type is `OptionalMediaRole`, so
 *    `addGalleryPhoto('label_photo', file)` does not compile — and if a
 *    JavaScript caller reaches it anyway, the role is refused **before the
 *    file is read**, which is what "enforced at the intake boundary" means.
 *  - **A dropped pin is not a fix** (v02 §9). `dropPin()` and the GPS
 *    acquisition produce different `position_source` values through different
 *    functions, and neither can produce the other's.
 *  - **Nothing blocks on the network.** Photograph bytes go to OPFS at the
 *    moment of capture and rows go to SQLite and the outbox at save. There is
 *    no `fetch` in this file, and there must never be one.
 *  - **Missing data flags, it does not drop** (v02 §3). A point with two of
 *    three photographs and a poor fix still saves. `advisories` says what the
 *    server will raise; it never bars the save. The sampler is standing in a
 *    field and the alternative to an imperfect record is no record.
 */

import { uuidv7 } from 'uuidv7';
import type { ProjectSamplingSpec } from '../../shared/contract/bundle.js';
import type { CaptureSource, MediaRole } from '../../shared/contract/common.js';
import type {
  FieldVisitPayload,
  MediaMetaPayload,
  SampleBagPayload,
  SampleConditionPayload,
  SamplePointPayload,
} from '../../shared/contract/entities.js';
import { DEFECT_CODE } from '../../shared/codes/index.js';
import type { SqlDatabase } from '../../shared/db/types.js';
import type { LatLon } from '../../shared/geo/distance.js';
import {
  GpsAcquisition,
  advisoryOffsetFromPlan,
  manualPinCapture,
  type GeolocationLike,
  type GpsCaptureResult,
  type GpsState,
} from './gps.js';
import {
  attachToRole,
  intakeFromCamera,
  intakeFromGallery,
  type AttachContext,
} from './camera/intake.js';
import { isRequiredRole, type IntakeImage, type OptionalMediaRole } from './camera/types.js';
import type { ProcessOptions } from './camera/pipeline.js';
import { browserImaging } from './camera/imaging.js';
import {
  CameraUnavailableError,
  LiveCameraSource,
  type CameraSource,
  type CameraStatus,
  type CameraUnavailableReason,
} from './camera/source.js';
import {
  mediaLocalPath,
  objectUrlFor,
  revokeObjectUrl,
  type MediaBlobStore,
} from './media-blobs.js';
import { writeCaptureLocally, type StoredMedia } from './save.js';

/**
 * The spec fields capture reads. Every threshold comes from
 * `REF.PROJECT_SAMPLING_SPEC` via the assignment bundle — none is a constant
 * in this codebase, and none may become one.
 */
export type CaptureSpec = Pick<
  ProjectSamplingSpec,
  | 'spec_id'
  | 'period_code'
  | 'protocol_version'
  | 'required_media_roles'
  | 'gps_accuracy_required_m'
  | 'min_gps_fix_count'
  | 'max_plan_offset_m_warn'
  | 'max_plan_offset_m_block'
>;

export interface AttachedPhoto {
  media_id: string;
  media_role: MediaRole;
  capture_source: CaptureSource;
  content_hash: string;
  bytes: number;
  width_px: number;
  height_px: number;
  capture_ts_device: string;
  exif_gps_present: boolean;
  /** For the tile. Revoked by `removePhoto`/`discard`; null outside a browser. */
  preview_url: string | null;
}

/**
 * What the record will be flagged for, computed on the device so the sampler
 * sees it while they can still do something about it.
 *
 * Advisory only. The server's rules are authoritative — these are the same
 * codes so the two agree, and the device raises no `local_defect` row from
 * here: `MISSING_REQUIRED_MEDIA`, `NO_GPS_FIX`, `GPS_ACCURACY_EXCEEDED` and
 * `MANUAL_POSITION` are all derivable server-side from the row itself, and a
 * device-raised duplicate would mean two defect rows for one fact.
 */
export interface CaptureAdvisory {
  code: string;
  detail: string;
}

export interface CaptureSessionState {
  sample_uid: string;
  gps: GpsState;
  /** The position as it would be written right now. Null until a usable fix. */
  position: GpsCaptureResult | null;
  /** Advisory only — the server recomputes it (contract §6 step 6). */
  offset_from_plan_m: number | null;
  camera_status: CameraStatus;
  camera_error: CameraUnavailableReason | null;
  photos: AttachedPhoto[];
  missing_required_roles: MediaRole[];
  deviation_reason_code: string | null;
  advisories: CaptureAdvisory[];
  saved: boolean;
}

export type PhotoRefusalReason =
  | 'gallery_not_allowed_for_required_role'
  | 'camera_unavailable'
  | 'frame_grab_failed'
  | 'image_unreadable'
  | 'blob_write_failed'
  | 'already_saved';

export type CapturePhotoOutcome =
  | { ok: true; photo: AttachedPhoto }
  | { ok: false; reason: PhotoRefusalReason; detail?: string };

export interface CaptureSessionOptions {
  db: SqlDatabase;
  spec: CaptureSpec;
  visit_id: string;
  /** Upserted at save when given, so capture works before a visit row exists. */
  visit?: FieldVisitPayload | null;
  /** Null for a field-added point (v02 §2, Screen 2 long-press). */
  plan_point_id?: string | null;
  /** The planned position, for the advisory offset chip only. */
  planned?: LatLon | null;
  device_id: string | null;
  sampler_person_id?: string | null;
  blobs: MediaBlobStore;
  /** Defaults to canvas + `exifr` + WebCrypto. */
  imaging?: ProcessOptions;
  /** Defaults to `getUserMedia`. A Capacitor adapter swaps in here. */
  camera?: CameraSource;
  /** Defaults to `navigator.geolocation`. */
  geolocation?: GeolocationLike;
  now?: () => number;
  newId?: () => string;
  /** Milliseconds since app start; `performance.now()` when available. */
  uptimeMs?: () => number | null;
}

export interface CaptureSaveInput {
  conditions?: ReadonlyArray<{
    condition_code: string;
    condition_value?: string | null;
    code_set_version?: string | null;
  }>;
  /**
   * The bag, with its barcode **exactly as it was scanned**. Nothing in this
   * file trims, upper-cases or re-formats it (v02 §3); the lab's pattern is
   * an advisory check elsewhere and never a reason to rewrite a scan.
   */
  bags?: ReadonlyArray<Omit<SampleBagPayload, 'bag_id' | 'sample_uid'> & { bag_id?: string }>;
  note?: string | null;
  /** Exception capture only — null means "per spec" (D9). */
  depth_achieved_cm?: number | null;
  refusal_code?: string | null;
  cores_taken?: number | null;
  bd_core_taken?: boolean | null;
  supersedes_sample_uid?: string | null;
}

export interface CaptureSaveResult {
  sample_uid: string;
  media_ids: string[];
  queued: number;
  advisories: CaptureAdvisory[];
}

export class CaptureSession {
  readonly sample_uid: string;

  private readonly gps: GpsAcquisition;
  private readonly camera: CameraSource;
  private readonly imaging: ProcessOptions;
  private readonly listeners = new Set<(state: CaptureSessionState) => void>();
  private readonly photos: AttachedPhoto[] = [];
  /** Media payloads for the photographs in hand, keyed by `media_id`. */
  private readonly pending = new Map<string, MediaMetaPayload>();
  private readonly now: () => number;
  private readonly newId: () => string;

  private pin: GpsCaptureResult | null = null;
  private cameraError: CameraUnavailableReason | null = null;
  private deviationReasonCode: string | null = null;
  private savedFlag = false;
  private unsubscribeGps: (() => void) | null = null;

  constructor(private readonly options: CaptureSessionOptions) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? uuidv7;
    this.sample_uid = this.newId();
    this.imaging = options.imaging ?? browserImaging();
    this.camera = options.camera ?? new LiveCameraSource({ now: this.now });
    this.gps = new GpsAcquisition(
      options.geolocation ?? navigatorGeolocation(),
      {
        accuracyRequiredM: options.spec.gps_accuracy_required_m,
        minFixCount: options.spec.min_gps_fix_count,
      },
      this.now,
    );
  }

  /** Call from the screen's mount. Starts the GPS watch; opens no camera. */
  start(): void {
    if (!this.unsubscribeGps) {
      this.unsubscribeGps = this.gps.subscribe(() => this.emit());
    }
    this.gps.start();
  }

  /** Call from the screen's unmount. Releases the receiver and the camera. */
  stop(): void {
    this.gps.stop();
    this.unsubscribeGps?.();
    this.unsubscribeGps = null;
    this.closeCamera();
  }

  subscribe(listener: (state: CaptureSessionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state());
    return () => this.listeners.delete(listener);
  }

  // ── camera ────────────────────────────────────────────────────────────────

  /**
   * Opens the viewfinder. The screen mounts `cameraView()` into its own
   * container; this module keeps ownership of the element.
   */
  async openCamera(): Promise<{ ok: true } | { ok: false; reason: CameraUnavailableReason }> {
    try {
      await this.camera.open();
      this.cameraError = null;
      this.emit();
      return { ok: true };
    } catch (err) {
      this.cameraError = err instanceof CameraUnavailableError ? err.reason : 'other';
      this.emit();
      return { ok: false, reason: this.cameraError };
    }
  }

  closeCamera(): void {
    this.camera.close();
    this.emit();
  }

  /** The `<video>` to mount. Null until `openCamera()` succeeds. */
  cameraView(): HTMLVideoElement | null {
    return this.camera.view;
  }

  // ── photographs ───────────────────────────────────────────────────────────

  /**
   * Takes a photograph for a role from the live camera.
   *
   * Works for required and optional roles alike: a live frame satisfies both.
   * The camera is opened on demand so a screen that only wants one photograph
   * does not have to sequence the lifecycle itself.
   */
  async capturePhoto(role: MediaRole): Promise<CapturePhotoOutcome> {
    if (this.savedFlag) return { ok: false, reason: 'already_saved' };

    if (this.camera.status !== 'live') {
      const opened = await this.openCamera();
      if (!opened.ok) return { ok: false, reason: 'camera_unavailable', detail: opened.reason };
    }

    let bytes: Uint8Array;
    try {
      const frame = await this.camera.grab();
      bytes = frame.bytes;
    } catch (err) {
      this.cameraError = err instanceof CameraUnavailableError ? err.reason : 'other';
      this.emit();
      return { ok: false, reason: 'frame_grab_failed', detail: this.cameraError };
    }

    let image;
    try {
      image = await intakeFromCamera(bytes, this.imaging);
    } catch (err) {
      return { ok: false, reason: 'image_unreadable', detail: messageOf(err) };
    }
    return this.attach(role, image);
  }

  /**
   * Adds a photograph from the camera roll to an **optional** role.
   *
   * `OptionalMediaRole` is the whole point of the signature:
   * `addGalleryPhoto('label_photo', file)` is a compile error, and the runtime
   * guard below catches the JavaScript caller — **before the file is read**,
   * so a required role never gets as far as having bytes.
   */
  async addGalleryPhoto(role: OptionalMediaRole, file: Blob): Promise<CapturePhotoOutcome> {
    if (this.savedFlag) return { ok: false, reason: 'already_saved' };
    if (isRequiredRole(role)) {
      return { ok: false, reason: 'gallery_not_allowed_for_required_role' };
    }

    let image;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      image = await intakeFromGallery(bytes, this.imaging);
    } catch (err) {
      return { ok: false, reason: 'image_unreadable', detail: messageOf(err) };
    }
    return this.attach(role, image);
  }

  /**
   * The one place a photograph becomes a media row.
   *
   * `attachToRole` re-checks `capture_source` against the role. Both callers
   * above have already made that impossible in their own way; this is the
   * third layer, and it is the one that survives someone adding a fourth
   * caller in 2027.
   */
  private async attach(role: MediaRole, image: IntakeImage): Promise<CapturePhotoOutcome> {
    const capturedTs = new Date(this.now()).toISOString();
    const context: AttachContext = {
      sample_uid: this.sample_uid,
      visit_id: this.options.visit_id,
      device_id: this.options.device_id,
      capture_order: this.photos.length + 1,
      captured_ts_device: capturedTs,
    };

    const outcome = attachToRole(role, image, context);
    if (!outcome.ok) return { ok: false, reason: outcome.reason };

    // Bytes before metadata. A blob with no row is reclaimable garbage; a row
    // with no blob is a photograph that can never be uploaded.
    try {
      await this.options.blobs.put(image.content_hash, image.bytes);
    } catch (err) {
      return { ok: false, reason: 'blob_write_failed', detail: messageOf(err) };
    }

    const photo: AttachedPhoto = {
      media_id: outcome.media.media_id,
      media_role: role,
      capture_source: outcome.media.capture_source,
      content_hash: image.content_hash,
      bytes: image.byte_length,
      width_px: image.width_px,
      height_px: image.height_px,
      capture_ts_device: capturedTs,
      exif_gps_present: image.exif_gps_present,
      preview_url: objectUrlFor(image.bytes, image.mime_type),
    };
    this.pending.set(photo.media_id, outcome.media);
    this.photos.push(photo);
    this.emit();
    return { ok: true, photo };
  }

  /**
   * Drops a photograph the sampler is not happy with.
   *
   * The bytes are removed only if no *saved* media row anywhere on the device
   * references that hash — content addressing means a re-taken photograph can
   * legitimately be a photograph another sample already relies on.
   */
  async removePhoto(mediaId: string): Promise<void> {
    const index = this.photos.findIndex((p) => p.media_id === mediaId);
    if (index < 0) return;
    const [photo] = this.photos.splice(index, 1);
    if (!photo) return;
    this.pending.delete(mediaId);
    revokeObjectUrl(photo.preview_url);
    await this.forgetBytesIfUnreferenced(photo.content_hash);
    this.emit();
  }

  /** Abandons the point. Frees preview URLs and unreferenced bytes. */
  async discard(): Promise<void> {
    for (const photo of [...this.photos]) await this.removePhoto(photo.media_id);
    this.stop();
  }

  private async forgetBytesIfUnreferenced(contentHash: string): Promise<void> {
    if (this.photos.some((p) => p.content_hash === contentHash)) return;
    const rows = await this.options.db.all<{ n: number }>(
      'SELECT COUNT(*) AS n FROM media WHERE content_hash = ?',
      [contentHash],
    );
    if (Number(rows[0]?.n ?? 0) > 0) return;
    await this.options.blobs.remove(contentHash);
  }

  // ── position ──────────────────────────────────────────────────────────────

  /**
   * Records a position the sampler placed by hand.
   *
   * A separate method producing a different `position_source`, permanently.
   * There is no argument to `capturePhoto`, `save` or anything else that turns
   * a pin into a fix.
   */
  dropPin(lat: number, lon: number): void {
    this.pin = manualPinCapture(lat, lon);
    this.emit();
  }

  /** Returns to the receiver's own answer. */
  clearPin(): void {
    this.pin = null;
    this.emit();
  }

  setDeviationReason(code: string | null): void {
    this.deviationReasonCode = code;
    this.emit();
  }

  // ── state ─────────────────────────────────────────────────────────────────

  state(): CaptureSessionState {
    const gpsState = this.gps.state();
    const position = this.pin ?? this.gps.result();
    const planned = this.options.planned ?? null;
    const offset =
      position && planned
        ? round(advisoryOffsetFromPlan({ lat: position.lat, lon: position.lon }, planned), 1)
        : null;
    const missing = this.missingRequiredRoles();

    return {
      sample_uid: this.sample_uid,
      gps: gpsState,
      position,
      offset_from_plan_m: offset,
      camera_status: this.camera.status,
      camera_error: this.cameraError,
      photos: [...this.photos],
      missing_required_roles: missing,
      deviation_reason_code: this.deviationReasonCode,
      advisories: this.advisories(position, missing, offset),
      saved: this.savedFlag,
    };
  }

  /**
   * Required roles still owed.
   *
   * Counts only `in_app_camera` photographs — the same rule as
   * `missingRequiredRoles` in `intake.ts`, applied to what is in hand rather
   * than to what was written.
   */
  private missingRequiredRoles(): MediaRole[] {
    const satisfied = new Set(
      this.photos.filter((p) => p.capture_source === 'in_app_camera').map((p) => p.media_role),
    );
    return this.options.spec.required_media_roles.filter((role) => !satisfied.has(role));
  }

  private advisories(
    position: GpsCaptureResult | null,
    missing: readonly MediaRole[],
    offset: number | null,
  ): CaptureAdvisory[] {
    const out: CaptureAdvisory[] = [];
    const spec = this.options.spec;

    if (!position) {
      out.push({ code: DEFECT_CODE.NO_GPS_FIX, detail: 'no usable fix yet' });
    } else if (position.position_source === 'manual_map_pin') {
      out.push({ code: DEFECT_CODE.MANUAL_POSITION, detail: 'position placed by hand' });
    } else if (
      position.gps_accuracy_m !== null &&
      position.gps_accuracy_m > spec.gps_accuracy_required_m
    ) {
      out.push({
        code: DEFECT_CODE.GPS_ACCURACY_EXCEEDED,
        detail: `${position.gps_accuracy_m} m against a ${spec.gps_accuracy_required_m} m threshold`,
      });
    }

    for (const role of missing) {
      out.push({ code: DEFECT_CODE.MISSING_REQUIRED_MEDIA, detail: role });
    }

    if (
      offset !== null &&
      offset > spec.max_plan_offset_m_block &&
      !this.deviationReasonCode
    ) {
      out.push({
        code: DEFECT_CODE.OFFSET_EXCEEDED_NO_REASON,
        detail: `${offset} m from plan, past the ${spec.max_plan_offset_m_block} m block threshold`,
      });
    }

    return out;
  }

  // ── save ──────────────────────────────────────────────────────────────────

  /**
   * Writes the point, its bags, its conditions and its media rows locally and
   * queues them all. Local only — see the file header.
   */
  async save(input: CaptureSaveInput = {}): Promise<CaptureSaveResult> {
    const nowIso = new Date(this.now()).toISOString();
    const position = this.pin ?? this.gps.result();
    const state = this.state();

    const sample: SamplePointPayload = {
      sample_uid: this.sample_uid,
      visit_id: this.options.visit_id,
      plan_point_id: this.options.plan_point_id ?? null,
      lat: position?.lat ?? null,
      lon: position?.lon ?? null,
      // A pin has no measured accuracy and reports none. `manualPinCapture`
      // is what decides that, not this file.
      gps_accuracy_m: position?.gps_accuracy_m ?? null,
      altitude_m: position?.altitude_m ?? null,
      altitude_accuracy_m: position?.altitude_accuracy_m ?? null,
      position_provider: position?.position_provider ?? null,
      position_source: position?.position_source ?? null,
      fix_count: position?.fix_count ?? null,
      fix_spread_m: position?.fix_spread_m ?? null,
      fix_samples_json: position?.fix_samples_json ?? null,
      deviation_reason_code: this.deviationReasonCode,
      captured_ts_device: nowIso,
      captured_ts_utc_offset: -new Date(this.now()).getTimezoneOffset(),
      device_uptime_ms: this.uptime(),
      sampler_person_id: this.options.sampler_person_id ?? null,
      device_id: this.options.device_id,
      period_code: this.options.spec.period_code,
      spec_id: this.options.spec.spec_id,
      protocol_version: this.options.spec.protocol_version,
      depth_achieved_cm: input.depth_achieved_cm ?? null,
      refusal_code: input.refusal_code ?? null,
      cores_taken: input.cores_taken ?? null,
      bd_core_taken: input.bd_core_taken ?? null,
      note: input.note ?? null,
      supersedes_sample_uid: input.supersedes_sample_uid ?? null,
    };

    const bags: SampleBagPayload[] = (input.bags ?? []).map((bag, index) => ({
      ...bag,
      bag_id: bag.bag_id ?? this.newId(),
      sample_uid: this.sample_uid,
      bag_seq: bag.bag_seq ?? index + 1,
    }));

    const conditions: SampleConditionPayload[] = (input.conditions ?? []).map((condition) => ({
      condition_id: this.newId(),
      sample_uid: this.sample_uid,
      condition_code: condition.condition_code,
      condition_value: condition.condition_value ?? null,
      code_set_version: condition.code_set_version ?? null,
    }));

    const media: StoredMedia[] = this.photos.map((photo) => {
      const payload = this.pending.get(photo.media_id);
      if (!payload) throw new Error(`media ${photo.media_id} has no payload`);
      return { payload, local_path: mediaLocalPath(payload.content_hash) };
    });

    const result = await writeCaptureLocally(
      this.options.db,
      { visit: this.options.visit ?? null, sample, bags, conditions, media },
      nowIso,
    );

    this.savedFlag = true;
    this.emit();
    return { ...result, advisories: state.advisories };
  }

  private uptime(): number | null {
    if (this.options.uptimeMs) return this.options.uptimeMs();
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      // Milliseconds since this app instance started — the web has no true
      // device uptime. Paired with `captured_ts_device` it still exposes a
      // clock moved *during* a session, which is the case that matters here;
      // across sessions, the bundle's `server_time` delta is the baseline.
      return Math.round(performance.now());
    }
    return null;
  }

  private emit(): void {
    const state = this.state();
    for (const listener of this.listeners) listener(state);
  }
}

export function createCaptureSession(options: CaptureSessionOptions): CaptureSession {
  return new CaptureSession(options);
}

function navigatorGeolocation(): GeolocationLike {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    // Not a thrown error: a device with location switched off must still be
    // able to open the screen, take photographs and save a flagged point.
    return {
      watchPosition(_success, error) {
        error?.({ code: 2, message: 'geolocation unavailable' } as GeolocationPositionError);
        return 0;
      },
      clearWatch() {},
    };
  }
  return navigator.geolocation;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function round(value: number, places: number): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}
