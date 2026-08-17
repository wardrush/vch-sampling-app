/**
 * The tutorial capture path, driven the way the tutorial screen drives it.
 *
 * The renderer is a double here for the same reason the camera is a double in
 * `session.test.ts`: `OffscreenCanvas` is a platform boundary and Node does not
 * have one. The claim that a tutorial capture completes **with no camera
 * hardware** is not made by this file — it is made in a real headless Chromium
 * and reported in `.claude/fleet/reports/capture-integrity-wave3.md`.
 *
 * What this file proves is everything else: the scripted receiver drives the
 * real averaging, the required roles are satisfiable without a camera, a pin is
 * still not a fix, and `save()` produces a record and writes nothing.
 */

import { describe, expect, it, vi } from 'vitest';
import { webCryptoHasher, type ProcessOptions } from '../camera/pipeline.js';
import { TUTORIAL_ID_PREFIX, isTutorialId } from '../tutorial-boundary.js';
import { TUTORIAL_GPS_TRACK, TUTORIAL_SPEC } from './model-data.js';
import { scriptedTutorialGeolocation } from './scripted-gps.js';
import { TUTORIAL_WATERMARK, type SyntheticImageSource } from './synthetic.js';
import { capturePhotoView } from './photo-view.js';
import { TutorialCaptureSession } from './session.js';

/** Stands in for `OffscreenCanvas`. Records what it was asked to draw. */
function renderer(): SyntheticImageSource & { calls: Array<{ role: string; index: number }> } {
  const calls: Array<{ role: string; index: number }> = [];
  return {
    calls,
    async render(role, index) {
      calls.push({ role, index });
      return {
        bytes: new TextEncoder().encode(`drawn:${role}:${index}:${TUTORIAL_WATERMARK}`),
        natural_width: 2400,
        natural_height: 1800,
        scene: role,
      };
    },
  };
}

function imaging(): ProcessOptions {
  return {
    codec: {
      async decode(bytes: Uint8Array) {
        return { source: new TextDecoder().decode(bytes), width: 2400, height: 1800 };
      },
      async encodeJpeg(source: unknown, width: number, height: number) {
        return new TextEncoder().encode(`jpeg:${width}x${height}:${String(source)}`);
      },
    },
    // A drawn image carries no EXIF, exactly as a `getUserMedia` frame carries
    // none. Nothing invented.
    exif: {
      async parse() {
        return { lat: null, lon: null, ts: null, raw: null };
      },
    },
    hasher: webCryptoHasher,
  };
}

/** Fires the whole scripted track immediately, in order. */
function instantGeolocation() {
  return scriptedTutorialGeolocation({
    schedule: (fn: () => void) => {
      fn();
      return 0;
    },
    cancel: () => {},
    now: () => Date.parse('2026-10-02T15:00:00Z'),
  });
}

function session(overrides: Partial<ConstructorParameters<typeof TutorialCaptureSession>[0]> = {}) {
  return new TutorialCaptureSession({
    imaging: imaging(),
    images: renderer(),
    geolocation: instantGeolocation(),
    now: () => Date.parse('2026-10-02T15:00:00Z'),
    ...overrides,
  });
}

describe('a tutorial capture completes without a camera', () => {
  it('satisfies all three required roles with no CameraSource in the object', async () => {
    const s = session();
    s.start();

    for (const role of TUTORIAL_SPEC.required_media_roles) {
      const outcome = await s.capturePhoto(role);
      expect(outcome.ok).toBe(true);
    }

    expect(s.state().missing_required_roles).toEqual([]);
    expect(s.state().photos).toHaveLength(3);
    // No `openCamera`, no `cameraView`. There is no camera on this object at
    // all -- which is why it works on a laptop and why it is not a fallback
    // for a camera that failed.
    expect('openCamera' in s).toBe(false);
    expect('cameraView' in s).toBe(false);
    expect('addGalleryPhoto' in s).toBe(false);
    s.discard();
  });

  it('marks every photo tutorial_synthetic and carries the watermark', async () => {
    const s = session();
    const outcome = await s.capturePhoto('core_photo');
    if (!outcome.ok) throw new Error(outcome.reason);

    expect(outcome.photo.capture_source).toBe('tutorial_synthetic');
    expect(outcome.photo.is_tutorial).toBe(true);
    expect(outcome.photo.watermark_text).toBe(TUTORIAL_WATERMARK);
    expect(outcome.photo.exif_gps_present).toBe(false);
    expect(isTutorialId(outcome.photo.media_id)).toBe(true);
  });

  it('runs the real downscale-and-hash pipeline, so the sizes shown are real', async () => {
    const s = session();
    const outcome = await s.capturePhoto('site_photo');
    if (!outcome.ok) throw new Error(outcome.reason);

    // 2400x1800 down to a 1920 long edge, preserving aspect (v02 §4.4).
    expect(outcome.photo.width_px).toBe(1920);
    expect(outcome.photo.height_px).toBe(1440);
    expect(outcome.photo.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.photo.bytes).toBeGreaterThan(0);
  });

  it('describes itself unmistakably in the tile view', async () => {
    const s = session();
    const outcome = await s.capturePhoto('label_photo');
    if (!outcome.ok) throw new Error(outcome.reason);

    const view = capturePhotoView(outcome.photo);
    expect(view.is_tutorial).toBe(true);
    expect(view.provenance_tone).toBe('tutorial');
    expect(view.provenance_label).toContain('TUTORIAL');
  });

  it('refuses rather than degrading when the renderer cannot draw', async () => {
    const s = session({
      images: {
        async render() {
          throw new Error('no OffscreenCanvas');
        },
      },
    });
    const outcome = await s.capturePhoto('core_photo');
    expect(outcome).toMatchObject({ ok: false, reason: 'render_failed' });
    // An unwatermarked tutorial image is worse than no tutorial image.
    expect(s.state().photos).toEqual([]);
  });
});

describe('the tutorial teaches the real GPS behaviour', () => {
  it('acquires on start, not on save, and runs the real averaging', () => {
    const s = session();
    expect(s.state().position).toBeNull();
    expect(s.state().advisories.some((a) => a.code === 'NO_GPS_FIX')).toBe(true);

    s.start();
    const state = s.state();
    expect(state.gps.fixes).toHaveLength(TUTORIAL_GPS_TRACK.length);
    // Median of the receiver's own claims -- 42/14/7/5/4 -> 7. Not shrunk by
    // averaging; this is `GpsAcquisition`, unmodified.
    expect(state.gps.accuracyM).toBe(7);
    expect(state.gps.meetsSpec).toBe(true);
    expect(state.position?.fix_count).toBe(5);
    expect(state.position?.fix_spread_m).toBeGreaterThan(0);
    s.stop();
  });

  it('never reports position_source gps — a simulated receiver is not a receiver', () => {
    const s = session();
    s.start();
    expect(s.state().position?.position_source).toBe('tutorial_simulated_gps');
    expect(s.state().position?.position_provider).toBe('tutorial_simulated');
    s.stop();
  });

  it('keeps a dropped pin distinct from a fix, with no invented accuracy', () => {
    const s = session();
    s.start();
    s.dropPin(47.5433, -99.1235);

    const position = s.state().position;
    expect(position?.position_source).toBe('tutorial_manual_map_pin');
    // Zero is not "none": a pin has no measured accuracy and reports none.
    expect(position?.gps_accuracy_m).toBeNull();
    expect(s.state().advisories.some((a) => a.code === 'MANUAL_POSITION')).toBe(true);

    s.clearPin();
    expect(s.state().position?.position_source).toBe('tutorial_simulated_gps');
    s.stop();
  });

  it('shows the instructive offset the model data was built to produce', () => {
    const s = session();
    s.start();
    const offset = s.state().offset_from_plan_m;
    expect(offset).not.toBeNull();
    expect(offset!).toBeGreaterThan(TUTORIAL_SPEC.max_plan_offset_m_warn);
    expect(offset!).toBeLessThan(TUTORIAL_SPEC.max_plan_offset_m_block);
    s.stop();
  });

  it('uses the project spec when the caller has one, not the model thresholds', () => {
    const strict = { ...TUTORIAL_SPEC, gps_accuracy_required_m: 3, min_gps_fix_count: 9 };
    const s = session({ spec: strict });
    s.start();
    expect(s.state().gps.meetsSpec).toBe(false);
    expect(s.state().advisories.some((a) => a.code === 'GPS_ACCURACY_EXCEEDED')).toBe(true);
    s.stop();
  });
});

describe('saving the tutorial writes nothing', () => {
  it('returns the record that would have existed and reports zero rows', async () => {
    const s = session();
    s.start();
    for (const role of TUTORIAL_SPEC.required_media_roles) await s.capturePhoto(role);

    const result = await s.save({ note: 'example', bag_count: 1, condition_count: 2 });

    expect(result.discarded).toBe(true);
    expect(result.rows_written).toBe(0);
    expect(result.would_queue).toBe(2 + 1 + 2 + 3);
    expect(result.media).toHaveLength(3);
    expect(result.notice).toContain('not field evidence');
    s.discard();
  });

  it('brands every identifier in the record with the reserved prefix', async () => {
    const s = session();
    s.start();
    await s.capturePhoto('core_photo');
    const result = await s.save();

    expect(result.sample.sample_uid.startsWith(TUTORIAL_ID_PREFIX)).toBe(true);
    expect(result.sample.visit_id.startsWith(TUTORIAL_ID_PREFIX)).toBe(true);
    expect(result.sample.plan_point_id.startsWith(TUTORIAL_ID_PREFIX)).toBe(true);
    for (const media of result.media) {
      expect(media.media_id.startsWith(TUTORIAL_ID_PREFIX)).toBe(true);
      expect(media.sample_uid.startsWith(TUTORIAL_ID_PREFIX)).toBe(true);
      expect(media.capture_source).toBe('tutorial_synthetic');
      expect(media.is_tutorial).toBe(true);
    }
    s.discard();
  });

  it('releases the simulated receiver on discard', () => {
    const cancel = vi.fn();
    const s = session({
      geolocation: scriptedTutorialGeolocation({
        schedule: (fn: () => void) => {
          fn();
          return 7;
        },
        cancel,
      }),
    });
    s.start();
    s.discard();
    expect(cancel).toHaveBeenCalled();
  });
});
