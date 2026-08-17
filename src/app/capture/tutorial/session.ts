/**
 * The tutorial's capture session. Plan v02 D18.
 *
 * Shaped like `CaptureSession` so the tutorial teaches the screen the sampler
 * will actually use, and **incapable of what `CaptureSession` does**, in four
 * independent ways:
 *
 *  1. **It has no database.** `TutorialCaptureSessionOptions` has no
 *     `SqlDatabase` field and no `MediaBlobStore` field, and nothing in this
 *     directory imports `save.js`, `sync/outbox-store.js`, `shared/db/*` or
 *     OPFS. `save()` returns the record that *would* have been written and
 *     writes nothing. A module with nothing to write to cannot write.
 *  2. **Its photographs are not `MediaMetaPayload`s.** A `TutorialMediaRecord`
 *     carries a `capture_source` of `tutorial_synthetic`, which is not a member
 *     of `CaptureSource`, so the type cannot be widened into the payload the
 *     writer accepts. This is checked by the compiler, not by a rule.
 *  3. **Every identifier it mints is in the reserved `tutorial-` namespace**,
 *     which the production `CaptureSession` constructor and
 *     `writeCaptureLocally` both refuse before doing anything else.
 *  4. **`mode` is the literal `'tutorial'`**, so it is not assignable to
 *     `CaptureSession` and a screen typed on one cannot be handed the other.
 *
 * It also never opens a camera. That is what makes the flow demonstrable on a
 * laptop, in a screen-share and in a headless browser — and it is why this is
 * not a camera fallback: a production session whose camera fails still leaves
 * the role visibly unsatisfied and still writes nothing, because a production
 * session cannot reach this file.
 *
 * The GPS is real code driven by a scripted receiver (`scripted-gps.ts`), so
 * the acquisition the tutorial shows is the acquisition that will happen.
 */

import { uuidv7 } from 'uuidv7';
import type { MediaRole } from '../../../shared/contract/common.js';
import { DEFECT_CODE } from '../../../shared/codes/index.js';
import type { LatLon } from '../../../shared/geo/distance.js';
import {
  GpsAcquisition,
  advisoryOffsetFromPlan,
  type GeolocationLike,
  type GpsState,
} from '../gps.js';
import type { ProcessOptions } from '../camera/pipeline.js';
import { browserImaging } from '../camera/imaging.js';
import { objectUrlFor, revokeObjectUrl } from '../media-blobs.js';
import type { CaptureAdvisory, CaptureSpec } from '../session.js';
import {
  tutorialId,
  type TutorialCaptureSource,
  type TutorialPositionSource,
} from '../tutorial-boundary.js';
import {
  TUTORIAL_NOTICE,
  TUTORIAL_WATERMARK,
  canvasSyntheticImages,
  intakeSyntheticImage,
  type SyntheticImageSource,
} from './synthetic.js';
import { TUTORIAL_PLAN_POINT, TUTORIAL_SPEC, type TutorialPlanPoint } from './model-data.js';
import { scriptedTutorialGeolocation } from './scripted-gps.js';

/**
 * A tutorial position.
 *
 * Same fields as `GpsCaptureResult` so a chip renders identically, except that
 * `position_source` is one of the two tutorial values. The fix/pin distinction
 * survives — it is the distinction v02 §9 is least willing to lose, and a
 * tutorial that blurred it would be teaching the one wrong lesson that matters.
 */
export interface TutorialPosition {
  lat: number;
  lon: number;
  /** Null for a pin. Zero is not "none" — see `manualPinCapture`. */
  gps_accuracy_m: number | null;
  altitude_m: number | null;
  altitude_accuracy_m: number | null;
  position_provider: 'tutorial_simulated' | 'tutorial_manual';
  position_source: TutorialPositionSource;
  fix_count: number;
  fix_spread_m: number;
  fix_samples_json: string;
}

export interface TutorialAttachedPhoto {
  media_id: string;
  media_role: MediaRole;
  capture_source: TutorialCaptureSource;
  content_hash: string;
  bytes: number;
  width_px: number;
  height_px: number;
  capture_ts_device: string;
  exif_gps_present: false;
  preview_url: string | null;
  /** Burnt into the pixels as well. Here so a tile can label it too. */
  watermark_text: string;
  scene: string;
  is_tutorial: true;
}

/**
 * The media row that would have existed. It never does.
 *
 * Field-for-field a `MediaMetaPayload` apart from `capture_source`, which is
 * the field that makes it un-writable. Kept close to the real shape on purpose:
 * the tutorial's closing screen shows the record, and showing a shape that is
 * not the real shape would teach the wrong thing about what is recorded.
 */
export interface TutorialMediaRecord {
  media_id: string;
  content_hash: string;
  sample_uid: string;
  media_role: MediaRole;
  is_required_role: boolean;
  capture_order: number;
  capture_ts_device: string;
  exif_lat: null;
  exif_lon: null;
  exif_ts: null;
  exif_gps_present: false;
  bytes: number;
  width_px: number;
  height_px: number;
  mime_type: string;
  capture_source: TutorialCaptureSource;
  is_tutorial: true;
}

export interface TutorialSampleRecord {
  sample_uid: string;
  visit_id: string;
  plan_point_id: string;
  lat: number | null;
  lon: number | null;
  gps_accuracy_m: number | null;
  position_provider: string | null;
  /** Not a `PositionSource`. Cannot be written to `sample_point`. */
  position_source: TutorialPositionSource | null;
  fix_count: number | null;
  fix_spread_m: number | null;
  deviation_reason_code: string | null;
  captured_ts_device: string;
  depth_achieved_cm: number | null;
  cores_taken: number | null;
  note: string | null;
  is_tutorial: true;
}

export interface TutorialCaptureSessionState {
  mode: 'tutorial';
  sample_uid: string;
  plan_point: TutorialPlanPoint;
  gps: GpsState;
  position: TutorialPosition | null;
  offset_from_plan_m: number | null;
  photos: TutorialAttachedPhoto[];
  missing_required_roles: MediaRole[];
  deviation_reason_code: string | null;
  advisories: CaptureAdvisory[];
  saved: boolean;
  /** For the banner. Constant, so a screen cannot forget to show it. */
  notice: string;
  watermark_text: string;
}

export type TutorialPhotoOutcome =
  | { ok: true; photo: TutorialAttachedPhoto }
  | { ok: false; reason: 'render_failed' | 'already_saved'; detail?: string };

export interface TutorialCaptureSessionOptions {
  /**
   * The project's real thresholds when the device has a bundle. Falls back to
   * `TUTORIAL_SPEC`, which is model data — see `model-data.ts`.
   */
  spec?: CaptureSpec;
  planPoint?: TutorialPlanPoint;
  /** Defaults to canvas + `exifr` + WebCrypto, the same wiring as production. */
  imaging?: ProcessOptions;
  /** Defaults to the watermarked canvas renderer. */
  images?: SyntheticImageSource;
  /** Defaults to the scripted receiver. Never `navigator.geolocation`. */
  geolocation?: GeolocationLike;
  now?: () => number;
  newId?: () => string;
}

/**
 * What the tutorial produces instead of a write.
 *
 * `would_queue` is the number the Outbox count *would* have moved by, so the
 * closing screen can say "five things would be queued; nothing was" — which is
 * the sentence D18 is after.
 */
export interface TutorialCaptureResult {
  discarded: true;
  rows_written: 0;
  would_queue: number;
  sample: TutorialSampleRecord;
  media: TutorialMediaRecord[];
  advisories: CaptureAdvisory[];
  notice: string;
}

export class TutorialCaptureSession {
  /** Not assignable to `CaptureSession`, whose `mode` is `'production'`. */
  readonly mode = 'tutorial' as const;

  readonly sample_uid: string;
  readonly visit_id: string;
  readonly plan_point: TutorialPlanPoint;
  readonly spec: CaptureSpec;

  private readonly gps: GpsAcquisition;
  private readonly imaging: ProcessOptions;
  private readonly images: SyntheticImageSource;
  private readonly listeners = new Set<(state: TutorialCaptureSessionState) => void>();
  private readonly photos: TutorialAttachedPhoto[] = [];
  private readonly records = new Map<string, TutorialMediaRecord>();
  private readonly now: () => number;
  private readonly newId: () => string;

  private pin: TutorialPosition | null = null;
  private deviationReasonCode: string | null = null;
  private savedFlag = false;
  private unsubscribeGps: (() => void) | null = null;

  constructor(options: TutorialCaptureSessionOptions = {}) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? uuidv7;
    this.spec = options.spec ?? TUTORIAL_SPEC;
    this.plan_point = options.planPoint ?? TUTORIAL_PLAN_POINT;
    this.sample_uid = tutorialId('sample', this.newId());
    this.visit_id = tutorialId('visit', this.newId());
    this.imaging = options.imaging ?? browserImaging();
    this.images = options.images ?? canvasSyntheticImages();
    this.gps = new GpsAcquisition(
      options.geolocation ?? scriptedTutorialGeolocation(),
      {
        accuracyRequiredM: this.spec.gps_accuracy_required_m,
        minFixCount: this.spec.min_gps_fix_count,
      },
      this.now,
    );
  }

  start(): void {
    if (!this.unsubscribeGps) {
      this.unsubscribeGps = this.gps.subscribe(() => this.emit());
    }
    this.gps.start();
  }

  stop(): void {
    this.gps.stop();
    this.unsubscribeGps?.();
    this.unsubscribeGps = null;
  }

  subscribe(listener: (state: TutorialCaptureSessionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state());
    return () => this.listeners.delete(listener);
  }

  /**
   * Produces the tutorial photograph for a role.
   *
   * Works for the three required roles, which is the whole reason this exists:
   * on a machine with no camera, `CaptureSession.capturePhoto` correctly
   * refuses and the demo stops there. Nothing about that refusal changes — this
   * is a different object, reachable only from the tutorial route.
   */
  async capturePhoto(role: MediaRole): Promise<TutorialPhotoOutcome> {
    if (this.savedFlag) return { ok: false, reason: 'already_saved' };

    let image;
    try {
      const frame = await this.images.render(role, this.photos.length);
      image = await intakeSyntheticImage(frame, this.imaging);
    } catch (err) {
      return {
        ok: false,
        reason: 'render_failed',
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    const capturedTs = new Date(this.now()).toISOString();
    const mediaId = tutorialId('media', this.newId());
    const isRequired = this.spec.required_media_roles.includes(role);

    const photo: TutorialAttachedPhoto = {
      media_id: mediaId,
      media_role: role,
      capture_source: image.capture_source,
      content_hash: image.content_hash,
      bytes: image.byte_length,
      width_px: image.width_px,
      height_px: image.height_px,
      capture_ts_device: capturedTs,
      exif_gps_present: false,
      preview_url: objectUrlFor(image.bytes, image.mime_type),
      watermark_text: image.watermark_text,
      scene: image.scene,
      is_tutorial: true,
    };

    this.records.set(mediaId, {
      media_id: mediaId,
      content_hash: image.content_hash,
      sample_uid: this.sample_uid,
      media_role: role,
      is_required_role: isRequired,
      capture_order: this.photos.length + 1,
      capture_ts_device: capturedTs,
      exif_lat: null,
      exif_lon: null,
      exif_ts: null,
      exif_gps_present: false,
      bytes: image.byte_length,
      width_px: image.width_px,
      height_px: image.height_px,
      mime_type: image.mime_type,
      capture_source: image.capture_source,
      is_tutorial: true,
    });

    this.photos.push(photo);
    this.emit();
    return { ok: true, photo };
  }

  removePhoto(mediaId: string): void {
    const index = this.photos.findIndex((p) => p.media_id === mediaId);
    if (index < 0) return;
    const [photo] = this.photos.splice(index, 1);
    if (photo) revokeObjectUrl(photo.preview_url);
    this.records.delete(mediaId);
    this.emit();
  }

  dropPin(lat: number, lon: number): void {
    this.pin = {
      lat,
      lon,
      gps_accuracy_m: null,
      altitude_m: null,
      altitude_accuracy_m: null,
      position_provider: 'tutorial_manual',
      position_source: 'tutorial_manual_map_pin',
      fix_count: 0,
      fix_spread_m: 0,
      fix_samples_json: JSON.stringify([]),
    };
    this.emit();
  }

  clearPin(): void {
    this.pin = null;
    this.emit();
  }

  setDeviationReason(code: string | null): void {
    this.deviationReasonCode = code;
    this.emit();
  }

  state(): TutorialCaptureSessionState {
    const position = this.pin ?? this.simulatedFix();
    const planned: LatLon = {
      lat: this.plan_point.planned_lat,
      lon: this.plan_point.planned_lon,
    };
    const offset = position
      ? round(advisoryOffsetFromPlan({ lat: position.lat, lon: position.lon }, planned), 1)
      : null;
    const missing = this.missingRequiredRoles();

    return {
      mode: 'tutorial',
      sample_uid: this.sample_uid,
      plan_point: this.plan_point,
      gps: this.gps.state(),
      position,
      offset_from_plan_m: offset,
      photos: [...this.photos],
      missing_required_roles: missing,
      deviation_reason_code: this.deviationReasonCode,
      advisories: this.advisories(position, missing, offset),
      saved: this.savedFlag,
      notice: TUTORIAL_NOTICE,
      watermark_text: TUTORIAL_WATERMARK,
    };
  }

  /**
   * Ends the tutorial point. **Writes nothing.**
   *
   * There is no `SqlDatabase` in this object to write to; the return value is
   * the record that a real save would have produced, for the closing screen to
   * show and then throw away.
   */
  async save(
    input: {
      note?: string | null;
      depth_achieved_cm?: number | null;
      cores_taken?: number | null;
      bag_count?: number;
      condition_count?: number;
    } = {},
  ): Promise<TutorialCaptureResult> {
    const state = this.state();
    const position = state.position;
    this.savedFlag = true;
    this.emit();

    const media = [...this.records.values()];
    return {
      discarded: true,
      rows_written: 0,
      // sample_point + field_visit + bags + conditions + media rows: what the
      // Outbox count would move by if this were real.
      would_queue: 2 + (input.bag_count ?? 1) + (input.condition_count ?? 0) + media.length,
      sample: {
        sample_uid: this.sample_uid,
        visit_id: this.visit_id,
        plan_point_id: this.plan_point.plan_point_id,
        lat: position?.lat ?? null,
        lon: position?.lon ?? null,
        gps_accuracy_m: position?.gps_accuracy_m ?? null,
        position_provider: position?.position_provider ?? null,
        position_source: position?.position_source ?? null,
        fix_count: position?.fix_count ?? null,
        fix_spread_m: position?.fix_spread_m ?? null,
        deviation_reason_code: this.deviationReasonCode,
        captured_ts_device: new Date(this.now()).toISOString(),
        depth_achieved_cm: input.depth_achieved_cm ?? null,
        cores_taken: input.cores_taken ?? null,
        note: input.note ?? null,
        is_tutorial: true,
      },
      media,
      advisories: state.advisories,
      notice: TUTORIAL_NOTICE,
    };
  }

  /** Frees preview URLs and releases the simulated receiver. */
  discard(): void {
    for (const photo of [...this.photos]) this.removePhoto(photo.media_id);
    this.stop();
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * `GpsAcquisition.result()` relabelled, never reinterpreted.
   *
   * The numbers are whatever the real averaging produced from the scripted
   * track. Only the two provenance strings are replaced, and they are replaced
   * with values that are not `PositionSource` members — so the relabelling can
   * only ever make a tutorial position less writable, never more.
   */
  private simulatedFix(): TutorialPosition | null {
    const result = this.gps.result();
    if (!result) return null;
    return {
      lat: result.lat,
      lon: result.lon,
      gps_accuracy_m: result.gps_accuracy_m,
      altitude_m: result.altitude_m,
      altitude_accuracy_m: result.altitude_accuracy_m,
      position_provider: 'tutorial_simulated',
      position_source: 'tutorial_simulated_gps',
      fix_count: result.fix_count,
      fix_spread_m: result.fix_spread_m,
      fix_samples_json: result.fix_samples_json,
    };
  }

  private missingRequiredRoles(): MediaRole[] {
    const satisfied = new Set(this.photos.map((p) => p.media_role));
    return this.spec.required_media_roles.filter((role) => !satisfied.has(role));
  }

  /** The same codes the production session raises, so the tutorial teaches them. */
  private advisories(
    position: TutorialPosition | null,
    missing: readonly MediaRole[],
    offset: number | null,
  ): CaptureAdvisory[] {
    const out: CaptureAdvisory[] = [];

    if (!position) {
      out.push({ code: DEFECT_CODE.NO_GPS_FIX, detail: 'no usable fix yet' });
    } else if (position.position_source === 'tutorial_manual_map_pin') {
      out.push({ code: DEFECT_CODE.MANUAL_POSITION, detail: 'position placed by hand' });
    } else if (
      position.gps_accuracy_m !== null &&
      position.gps_accuracy_m > this.spec.gps_accuracy_required_m
    ) {
      out.push({
        code: DEFECT_CODE.GPS_ACCURACY_EXCEEDED,
        detail: `${position.gps_accuracy_m} m against a ${this.spec.gps_accuracy_required_m} m threshold`,
      });
    }

    for (const role of missing) {
      out.push({ code: DEFECT_CODE.MISSING_REQUIRED_MEDIA, detail: role });
    }

    if (offset !== null && offset > this.spec.max_plan_offset_m_block && !this.deviationReasonCode) {
      out.push({
        code: DEFECT_CODE.OFFSET_EXCEEDED_NO_REASON,
        detail: `${offset} m from plan, past the ${this.spec.max_plan_offset_m_block} m block threshold`,
      });
    }

    return out;
  }

  private emit(): void {
    const state = this.state();
    for (const listener of this.listeners) listener(state);
  }
}

export function createTutorialCaptureSession(
  options: TutorialCaptureSessionOptions = {},
): TutorialCaptureSession {
  return new TutorialCaptureSession(options);
}

function round(value: number, places: number): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}
