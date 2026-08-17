/**
 * B8 (wave 2) — where camera bytes come from, and why a required role can
 * trust them.
 *
 * `intake.ts` decides what a `CameraImage` *is*; this file decides what is
 * allowed to become one. The two halves answer different halves of v02 §11
 * criterion 11: the type system stops a gallery image reaching a required
 * role, and this module stops a picked file becoming camera bytes in the first
 * place.
 *
 * **Why `getUserMedia` and not `<input capture="environment">`.** Both are
 * called "the camera" in casual speech and they are not the same claim:
 *
 *  - `<input type="file" capture="environment">` asks the *operating system*
 *    to open its camera app. On Android Chrome it does. On desktop Chrome and
 *    Firefox the attribute is ignored and the user gets a **file picker** —
 *    so a photograph pulled off a hard disk arrives through the path the app
 *    calls "in-app camera", and `MEDIA.capture_source` has no value that says
 *    "we asked for a camera and got a file browser". The record would be
 *    indistinguishable from a real capture, which is the one outcome the
 *    audit distinction exists to prevent.
 *  - `getUserMedia` returns a `MediaStream` from a camera device. There is no
 *    code path from a `File` to a live `MediaStreamTrack`, on any platform, so
 *    the pixels this module encodes came off a sensor. When there is no camera
 *    the call fails and the role stays unsatisfied — visibly, in the app,
 *    rather than silently, in the warehouse.
 *
 * **The cost, stated plainly: a `getUserMedia` frame carries no EXIF.** The
 * pixels never pass through the OS camera app's JPEG encoder, so there is no
 * `DateTimeOriginal` and no `GPSLatitude` to preserve — `exif_gps_present`
 * is honestly `false` and `EXIF_POSITION_MISMATCH` has nothing to compare on
 * required photographs. Nothing is destroyed; there was never anything there.
 * The independent-corroboration property of v02 §9 returns for required roles
 * with the Capacitor native camera (2027), which hands back a real JPEG with
 * EXIF *and* keeps the provenance guarantee — it implements `CameraSource`
 * and nothing above this file changes. See the wave-2 report.
 *
 * This module creates and owns the `<video>` element. The screen mounts it and
 * styles it; it never supplies pixels. That is deliberate — a screen holding
 * its own `<video>` could point it at `URL.createObjectURL(pickedFile)` and
 * grab a "camera" frame from a file, which is the same hole wearing a hat.
 */

import { LONG_EDGE_PX } from './pipeline.js';

/**
 * Encoded bytes grabbed from a live camera track, with what the platform will
 * say about the device that produced them.
 *
 * `provenance` is a single-member union on purpose: there is no other value it
 * can take, so widening it later is a deliberate, reviewable edit rather than
 * an accident.
 */
export interface CameraFrame {
  readonly provenance: 'live_camera_stream';
  readonly bytes: Uint8Array;
  /** Device clock at the grab. */
  readonly grabbed_ts: string;
  /** `MediaStreamTrack.label` — often the only device string a browser gives. */
  readonly track_label: string | null;
  /**
   * What the track reports, not what was asked for. A laptop webcam commonly
   * reports `user` or nothing at all; the record must not claim a rear camera
   * it did not get. **Nowhere to persist this today** — see the report.
   */
  readonly facing_mode: string | null;
  readonly natural_width: number;
  readonly natural_height: number;
}

export type CameraStatus = 'closed' | 'opening' | 'live' | 'unavailable';

export type CameraUnavailableReason =
  | 'no_media_devices'
  | 'no_dom'
  | 'permission_denied'
  | 'no_camera'
  | 'not_open'
  | 'track_ended'
  | 'frame_not_ready'
  | 'encode_failed'
  | 'other';

export class CameraUnavailableError extends Error {
  constructor(
    readonly reason: CameraUnavailableReason,
    detail?: string,
  ) {
    super(detail ? `camera unavailable (${reason}): ${detail}` : `camera unavailable (${reason})`);
    this.name = 'CameraUnavailableError';
  }
}

/**
 * The camera, as the capture session sees it.
 *
 * An implementation is a *platform adapter* — a browser stream, a Capacitor
 * plugin, a test double standing in for a phone. What it is not, and must
 * never be, is a wrapper around a file picker: the whole enforcement rests on
 * every implementer of this interface reading pixels off a sensor.
 */
export interface CameraSource {
  readonly status: CameraStatus;
  /** The element the screen mounts. Created here, owned here. */
  readonly view: HTMLVideoElement | null;
  open(): Promise<void>;
  grab(): Promise<CameraFrame>;
  close(): void;
}

/**
 * Quality of the *intermediate* grab, before the pipeline's 1920 px / q0.72
 * re-encode produces the bytes that are actually stored (v02 §4.4).
 *
 * Not an audit threshold and not from the spec — it exists only so the one
 * unavoidable double-encode costs as little as possible. The stored artefact
 * is still exactly what the storage budget assumes.
 */
export const FRAME_GRAB_QUALITY = 0.92;

export interface GrabbedFrame {
  bytes: Uint8Array;
  width: number;
  height: number;
}

export interface LiveCameraDeps {
  /** Defaults to `navigator.mediaDevices`. Injected so a test can run headless. */
  mediaDevices?: Pick<MediaDevices, 'getUserMedia'>;
  /** Defaults to the ambient `document`. */
  document?: Document;
  /** Defaults to `OffscreenCanvas`. */
  encodeFrame?: (video: HTMLVideoElement) => Promise<GrabbedFrame>;
  now?: () => number;
}

export class LiveCameraSource implements CameraSource {
  private stream: MediaStream | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private state: CameraStatus = 'closed';

  constructor(private readonly deps: LiveCameraDeps = {}) {}

  get status(): CameraStatus {
    return this.state;
  }

  get view(): HTMLVideoElement | null {
    return this.videoEl;
  }

  async open(): Promise<void> {
    if (this.state === 'live') return;
    this.state = 'opening';

    const mediaDevices =
      this.deps.mediaDevices ??
      (typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined);
    if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
      this.state = 'unavailable';
      throw new CameraUnavailableError('no_media_devices');
    }

    let stream: MediaStream;
    try {
      stream = await mediaDevices.getUserMedia({
        // `ideal`, not `exact`: an exact constraint throws on a device with
        // only a front camera, and a front-camera photograph of the hole is
        // still a photograph taken at the hole. What was actually used is
        // reported back in `facing_mode`.
        video: { facingMode: { ideal: 'environment' }, width: { ideal: LONG_EDGE_PX } },
        audio: false,
      });
    } catch (err) {
      this.state = 'unavailable';
      throw new CameraUnavailableError(classifyGetUserMediaError(err), errorText(err));
    }

    const doc = this.deps.document ?? (typeof document !== 'undefined' ? document : null);
    if (!doc) {
      stopTracks(stream);
      this.state = 'unavailable';
      throw new CameraUnavailableError('no_dom');
    }

    const video = doc.createElement('video');
    video.setAttribute('playsinline', 'true');
    video.setAttribute('autoplay', 'true');
    video.muted = true;
    video.srcObject = stream;
    // A muted inline video is allowed to autoplay everywhere the app runs; if
    // a platform still refuses, `grab()` fails loudly on `frame_not_ready`
    // rather than this throwing during mount.
    try {
      await video.play();
    } catch {
      /* see above */
    }

    this.stream = stream;
    this.videoEl = video;
    this.state = 'live';
  }

  /**
   * One frame, checked live at the moment it is taken.
   *
   * The `readyState` check is not defensive coding: a track that has ended —
   * the user revoked permission, another app grabbed the camera, the phone
   * locked — leaves the last painted frame sitting in the element, and
   * encoding that would silently attach a photograph of somewhere the sampler
   * used to be standing.
   */
  async grab(): Promise<CameraFrame> {
    if (!this.stream || !this.videoEl) throw new CameraUnavailableError('not_open');

    const track = this.stream.getVideoTracks()[0];
    if (!track || track.readyState !== 'live') {
      this.state = 'unavailable';
      throw new CameraUnavailableError('track_ended');
    }

    const encode = this.deps.encodeFrame ?? offscreenCanvasFrameEncoder;
    const shot = await encode(this.videoEl);
    const settings = typeof track.getSettings === 'function' ? track.getSettings() : {};

    return Object.freeze({
      provenance: 'live_camera_stream' as const,
      bytes: shot.bytes,
      grabbed_ts: new Date(this.deps.now?.() ?? Date.now()).toISOString(),
      track_label: track.label || null,
      facing_mode: (settings as MediaTrackSettings).facingMode ?? null,
      natural_width: shot.width,
      natural_height: shot.height,
    });
  }

  /**
   * Releases the camera. Not optional politeness — a held track keeps the
   * sensor and its ISP powered, and v02 §3 budgets a ten-hour day.
   */
  close(): void {
    if (this.stream) stopTracks(this.stream);
    if (this.videoEl) {
      this.videoEl.srcObject = null;
      this.videoEl.remove();
    }
    this.stream = null;
    this.videoEl = null;
    this.state = 'closed';
  }
}

export async function offscreenCanvasFrameEncoder(video: HTMLVideoElement): Promise<GrabbedFrame> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) throw new CameraUnavailableError('frame_not_ready');

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new CameraUnavailableError('encode_failed', '2d context unavailable');
  ctx.drawImage(video, 0, 0, width, height);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: FRAME_GRAB_QUALITY });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width, height };
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      /* a track that is already gone needs no stopping */
    }
  }
}

function classifyGetUserMediaError(err: unknown): CameraUnavailableReason {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'permission_denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no_camera';
  return 'other';
}

function errorText(err: unknown): string | undefined {
  if (err instanceof Error) return err.message;
  return err === undefined ? undefined : String(err);
}
