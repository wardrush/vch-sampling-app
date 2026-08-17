/**
 * B6 and B8 — the two escalated capture tasks.
 *
 * Both are here because the property being tested is an audit property rather
 * than a UI one: what a row means when someone reads it in 2029.
 */

import { describe, expect, it, vi } from 'vitest';
import { GpsAcquisition, manualPinCapture, type GeolocationLike } from '../../src/app/capture/gps.js';
import { processImage, targetSize, webCryptoHasher } from '../../src/app/capture/camera/pipeline.js';
import {
  attachOptionalRole,
  attachRequiredRole,
  attachToRole,
  intakeFromCamera,
  intakeFromGallery,
  missingRequiredRoles,
} from '../../src/app/capture/camera/intake.js';

function fakeGeolocation(fixes: Array<{ lat: number; lon: number; accuracy: number }>): GeolocationLike {
  return {
    watchPosition(success) {
      for (const fix of fixes) {
        success({
          coords: {
            latitude: fix.lat,
            longitude: fix.lon,
            accuracy: fix.accuracy,
            altitude: 610,
            altitudeAccuracy: 8,
            heading: null,
            speed: null,
          },
          timestamp: Date.parse('2026-10-02T15:00:00Z'),
        } as GeolocationPosition);
      }
      return 1;
    },
    clearWatch() {},
  };
}

describe('B6 — GPS acquisition', () => {
  it('averages several fixes and records the spread', () => {
    const gps = new GpsAcquisition(
      fakeGeolocation([
        { lat: 47.9, lon: -103.2, accuracy: 5 },
        { lat: 47.90001, lon: -103.2, accuracy: 4 },
        { lat: 47.90002, lon: -103.2, accuracy: 6 },
      ]),
      { accuracyRequiredM: 10, minFixCount: 3 },
    );
    gps.start();

    const result = gps.result()!;
    expect(result.fix_count).toBe(3);
    expect(result.position_source).toBe('gps');
    expect(result.lat).toBeGreaterThan(47.9);
    expect(result.lat).toBeLessThan(47.90002);
    expect(result.fix_spread_m).toBeGreaterThan(0);
    // Every fix survives verbatim, including any excluded from the estimate.
    expect(JSON.parse(result.fix_samples_json)).toHaveLength(3);
  });

  it('does not let averaging shrink the reported accuracy', () => {
    const gps = new GpsAcquisition(
      fakeGeolocation([
        { lat: 47.9, lon: -103.2, accuracy: 6 },
        { lat: 47.9, lon: -103.2, accuracy: 6 },
        { lat: 47.9, lon: -103.2, accuracy: 6 },
        { lat: 47.9, lon: -103.2, accuracy: 6 },
      ]),
      { accuracyRequiredM: 10, minFixCount: 3 },
    );
    gps.start();
    // Four identical 6 m fixes stay 6 m. Treating them as independent samples
    // would report 3 m and manufacture a precision claim.
    expect(gps.result()!.gps_accuracy_m).toBe(6);
  });

  it('excludes a wild fix from the estimate but keeps it in the record', () => {
    const gps = new GpsAcquisition(
      fakeGeolocation([
        { lat: 47.9, lon: -103.2, accuracy: 5 },
        { lat: 48.5, lon: -103.9, accuracy: 1200 },
        { lat: 47.90001, lon: -103.2, accuracy: 5 },
      ]),
      { accuracyRequiredM: 10, minFixCount: 2 },
    );
    gps.start();

    const result = gps.result()!;
    expect(result.fix_count).toBe(2);
    expect(result.lat).toBeCloseTo(47.9, 3);
    expect(JSON.parse(result.fix_samples_json)).toHaveLength(3);
  });

  it('reports whether the spec threshold is met, live', () => {
    const gps = new GpsAcquisition(
      fakeGeolocation([{ lat: 47.9, lon: -103.2, accuracy: 25 }]),
      { accuracyRequiredM: 10, minFixCount: 3 },
    );
    const seen: boolean[] = [];
    gps.subscribe((state) => seen.push(state.meetsSpec));
    gps.start();

    expect(gps.state().meetsSpec).toBe(false);
    expect(seen.length).toBeGreaterThan(0);
  });

  it('keeps a dropped pin permanently distinct from a fix', () => {
    const pin = manualPinCapture(47.9, -103.2);
    expect(pin.position_source).toBe('manual_map_pin');
    expect(pin.fix_count).toBe(0);
    expect(JSON.parse(pin.fix_samples_json)).toEqual([]);
  });

  it('stops the watch when the screen closes', () => {
    const clearWatch = vi.fn();
    const gps = new GpsAcquisition(
      { watchPosition: () => 7, clearWatch },
      { accuracyRequiredM: 10, minFixCount: 3 },
    );
    gps.start();
    gps.stop();
    expect(clearWatch).toHaveBeenCalledWith(7);
  });
});

const codec = {
  async decode() {
    return { source: 'bitmap', width: 4032, height: 3024 };
  },
  async encodeJpeg(_source: unknown, width: number, height: number) {
    return new TextEncoder().encode(`jpeg:${width}x${height}`);
  },
};

const exif = {
  async parse() {
    return {
      lat: 47.9,
      lon: -103.2,
      ts: '2026-10-02T15:00:00Z',
      raw: { Make: 'Test', GPSLatitude: 47.9 },
    };
  },
};

const options = { codec, exif, hasher: webCryptoHasher };

describe('B8 — image pipeline', () => {
  it('downscales to a 1920 px long edge and preserves aspect ratio', () => {
    expect(targetSize(4032, 3024, 1920)).toEqual({ width: 1920, height: 1440 });
    expect(targetSize(3024, 4032, 1920)).toEqual({ width: 1440, height: 1920 });
  });

  it('never upscales an image that is already smaller', () => {
    expect(targetSize(800, 600, 1920)).toEqual({ width: 800, height: 600 });
  });

  it('reads EXIF from the original bytes, before the re-encode strips it', async () => {
    const processed = await processImage(new Uint8Array([1, 2, 3]), options);
    expect(processed.exif_lat).toBe(47.9);
    expect(processed.exif_gps_present).toBe(true);
    expect(processed.exif_raw).toEqual({ Make: 'Test', GPSLatitude: 47.9 });
  });

  it('hashes the stored bytes, not the original', async () => {
    const processed = await processImage(new Uint8Array([1, 2, 3]), options);
    const expected = await webCryptoHasher.sha256Hex(processed.bytes);
    expect(processed.content_hash).toBe(expected);
  });
});

describe('B8 — capture_source enforcement (v02 §11 criterion 11)', () => {
  it('marks a camera image in_app_camera and a gallery image device_gallery', async () => {
    const camera = await intakeFromCamera(new Uint8Array([1]), options);
    const gallery = await intakeFromGallery(new Uint8Array([1]), options);
    expect(camera.capture_source).toBe('in_app_camera');
    expect(gallery.capture_source).toBe('device_gallery');
  });

  it('refuses a gallery image for a required role', async () => {
    const gallery = await intakeFromGallery(new Uint8Array([1]), options);
    const outcome = attachToRole('label_photo', gallery, { device_id: 'dev' });
    expect(outcome).toEqual({ ok: false, reason: 'gallery_not_allowed_for_required_role' });
  });

  it('permanently marks a gallery image attached to an optional role', async () => {
    const gallery = await intakeFromGallery(new Uint8Array([1]), options);
    const media = attachOptionalRole('issue_photo', gallery, { device_id: 'dev' });
    expect(media.capture_source).toBe('device_gallery');
    expect(media.is_required_role).toBe(false);
  });

  it('accepts a camera image for a required role', async () => {
    const camera = await intakeFromCamera(new Uint8Array([1]), options);
    const media = attachRequiredRole('core_photo', camera, { device_id: 'dev', sample_uid: 's1' });
    expect(media.is_required_role).toBe(true);
    expect(media.capture_source).toBe('in_app_camera');
    expect(media.exif_lat).toBe(47.9);
  });

  it('throws if a JavaScript caller casts its way past the type', async () => {
    const gallery = await intakeFromGallery(new Uint8Array([1]), options);
    expect(() =>
      attachRequiredRole('label_photo', gallery as never, { device_id: 'dev' }),
    ).toThrow(/in-app camera images only/);
  });

  it('does not count a gallery photo toward a required role', async () => {
    const gallery = await intakeFromGallery(new Uint8Array([1]), options);
    const attached = [attachOptionalRole('other', gallery, { device_id: 'dev' })];
    expect(missingRequiredRoles(['label_photo', 'core_photo', 'site_photo'], attached)).toEqual([
      'label_photo',
      'core_photo',
      'site_photo',
    ]);
  });
});
