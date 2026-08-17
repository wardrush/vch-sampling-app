/**
 * The capture path end to end, driven the way a screen drives it.
 *
 * Everything here runs against real SQLite (`node:sqlite`) with the real
 * device migrations, and against the **demo bundle fixture** — so the
 * thresholds under test are the ones `REF.PROJECT_SAMPLING_SPEC` actually
 * ships (10 m, 3 fixes, three required roles) rather than numbers invented in
 * a test file.
 *
 * The camera is a double. That is the platform boundary, not the provenance
 * claim: the double stands in for a `MediaStream`, and nothing it can do
 * turns a picked file into a required-role photograph. v02 §11 criteria 6 and
 * 7 need real hardware in a real field and **no test here claims them.**
 */

import { beforeEach, describe, expect, it } from 'vitest';
import bundleFixture from '../../../fixtures/bundle.f26-demo.json';
import { NodeSqliteDb } from '../../../tests/support/node-sqlite.js';
import { bootstrapDeviceDb } from '../../shared/db/schema.js';
import type { AssignmentBundle } from '../../shared/contract/bundle.js';
import type { SqlDatabase } from '../../shared/db/types.js';
import { CaptureSession, type CaptureSpec } from './session.js';
import { MemoryMediaBlobStore } from './media-blobs.js';
import { webCryptoHasher, type ProcessOptions } from './camera/pipeline.js';
import {
  CameraUnavailableError,
  type CameraFrame,
  type CameraSource,
  type CameraStatus,
} from './camera/source.js';
import type { GeolocationLike } from './gps.js';

const bundle = bundleFixture as unknown as AssignmentBundle;
const spec = bundle.specs[0] as CaptureSpec;
const planPoint = bundle.plan_points[0]!;

/** A camera. Not a file picker — see the file header. */
class FakeCamera implements CameraSource {
  status: CameraStatus = 'closed';
  readonly view = null;
  grabs = 0;

  constructor(private readonly available = true) {}

  async open(): Promise<void> {
    if (!this.available) {
      this.status = 'unavailable';
      throw new CameraUnavailableError('no_camera');
    }
    this.status = 'live';
  }

  async grab(): Promise<CameraFrame> {
    if (this.status !== 'live') throw new CameraUnavailableError('not_open');
    this.grabs += 1;
    return {
      provenance: 'live_camera_stream',
      bytes: new TextEncoder().encode(`sensor-frame-${this.grabs}`),
      grabbed_ts: '2026-10-02T15:00:00.000Z',
      track_label: 'back camera',
      facing_mode: 'environment',
      natural_width: 1920,
      natural_height: 1080,
    };
  }

  close(): void {
    this.status = 'closed';
  }
}

/** EXIF the photograph carries. Deliberately *not* the position the GPS gives. */
const EXIF_RAW = { Make: 'Test', Model: 'Phone', GPSLatitude: [47, 54, 1.8] };
const EXIF_LAT = 47.90050001;
const EXIF_LON = -103.20030002;
const EXIF_TS = '2026-10-02T15:00:00';

function imaging(): ProcessOptions {
  return {
    codec: {
      async decode(bytes: Uint8Array) {
        return { source: new TextDecoder().decode(bytes), width: 4032, height: 3024 };
      },
      async encodeJpeg(source: unknown, width: number, height: number) {
        return new TextEncoder().encode(`jpeg:${width}x${height}:${String(source)}`);
      },
    },
    exif: {
      async parse() {
        return { lat: EXIF_LAT, lon: EXIF_LON, ts: EXIF_TS, raw: EXIF_RAW };
      },
    },
    hasher: webCryptoHasher,
  };
}

function geolocationWith(
  fixes: ReadonlyArray<{ lat: number; lon: number; accuracy: number }>,
  counter?: { watches: number },
): GeolocationLike {
  return {
    watchPosition(success) {
      if (counter) counter.watches += 1;
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

const GOOD_FIXES = [
  { lat: 47.5432, lon: -99.1234, accuracy: 5 },
  { lat: 47.54321, lon: -99.1234, accuracy: 4 },
  { lat: 47.54322, lon: -99.1234, accuracy: 6 },
];

interface Harness {
  db: SqlDatabase;
  blobs: MemoryMediaBlobStore;
  camera: FakeCamera;
  session: CaptureSession;
}

async function harness(
  options: {
    fixes?: ReadonlyArray<{ lat: number; lon: number; accuracy: number }>;
    cameraAvailable?: boolean;
    watches?: { watches: number };
  } = {},
): Promise<Harness> {
  const db = new NodeSqliteDb();
  await bootstrapDeviceDb(db);
  const blobs = new MemoryMediaBlobStore();
  const camera = new FakeCamera(options.cameraAvailable ?? true);

  const session = new CaptureSession({
    db,
    spec,
    visit_id: 'visit-0001',
    visit: {
      visit_id: 'visit-0001',
      boundary_id: planPoint.boundary_id ?? 'bnd-001',
      plan_id: null,
      spec_id: spec.spec_id,
      crew_org_id: null,
      sampler_person_id: null,
      device_id: 'dev-0001',
      access_contact_person_id: null,
      visit_date: '2026-10-02',
      started_ts: '2026-10-02T14:00:00Z',
      ended_ts: null,
      status: 'in_progress',
      abandon_reason_code: null,
      visit_note: null,
      app_version: 'test',
    },
    plan_point_id: planPoint.plan_point_id,
    planned: { lat: planPoint.planned_lat, lon: planPoint.planned_lon },
    device_id: 'dev-0001',
    sampler_person_id: 'per-0001',
    blobs,
    camera,
    imaging: imaging(),
    geolocation: geolocationWith(options.fixes ?? GOOD_FIXES, options.watches),
    now: () => Date.parse('2026-10-02T15:05:00Z'),
    uptimeMs: () => 123456,
  });

  return { db, blobs, camera, session };
}

describe('capture session — the flow a screen drives', () => {
  it('acquires GPS when the screen opens and never re-acquires at save', async () => {
    const watches = { watches: 0 };
    const { session } = await harness({ watches });

    expect(watches.watches).toBe(0);
    session.start();
    expect(watches.watches).toBe(1);

    // A position exists before anything is submitted — v02 §3.
    const before = session.state().position;
    expect(before?.position_source).toBe('gps');
    expect(before?.fix_count).toBe(3);

    await session.save();
    expect(watches.watches).toBe(1);
  });

  it('takes the three required photographs and satisfies every required role', async () => {
    const { session } = await harness();
    session.start();

    expect(session.state().missing_required_roles).toEqual([
      'label_photo',
      'core_photo',
      'site_photo',
    ]);

    for (const role of ['label_photo', 'core_photo', 'site_photo'] as const) {
      const outcome = await session.capturePhoto(role);
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.photo.capture_source).toBe('in_app_camera');
    }

    expect(session.state().missing_required_roles).toEqual([]);
    expect(session.state().advisories).toEqual([]);
  });

  it('stores the bytes under their own hash and downscales to the budgeted size', async () => {
    const { session, blobs } = await harness();
    session.start();
    const outcome = await session.capturePhoto('site_photo');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const stored = await blobs.read(outcome.photo.content_hash);
    expect(stored).not.toBeNull();
    // v02 §4.4 — 1920 px long edge. The hash addresses the bytes that are kept.
    expect(new TextDecoder().decode(stored!)).toContain('1920x1440');
    expect(await webCryptoHasher.sha256Hex(stored!)).toBe(outcome.photo.content_hash);
  });

  it('keeps EXIF verbatim and never reconciles it with the GPS fix', async () => {
    const { session, db } = await harness();
    session.start();
    await session.capturePhoto('site_photo');
    await session.save();

    const media = await db.all<{
      exif_lat: number;
      exif_lon: number;
      exif_ts: string;
      exif_raw: string;
      exif_gps_present: number;
    }>('SELECT exif_lat, exif_lon, exif_ts, exif_raw, exif_gps_present FROM media');
    expect(media).toHaveLength(1);

    const row = media[0]!;
    // Full precision, untouched, and *different* from the app's own fix.
    expect(row.exif_lat).toBe(EXIF_LAT);
    expect(row.exif_lon).toBe(EXIF_LON);
    expect(row.exif_ts).toBe(EXIF_TS);
    expect(JSON.parse(row.exif_raw)).toEqual(EXIF_RAW);
    expect(row.exif_gps_present).toBe(1);

    const sample = await db.all<{ lat: number; lon: number }>('SELECT lat, lon FROM sample_point');
    expect(sample[0]!.lat).not.toBe(row.exif_lat);
    // The disagreement is the point: EXIF_POSITION_MISMATCH is a finding, and
    // it only exists because neither number was moved toward the other.
  });

  it('saves offline — rows and outbox entries, no network of any kind', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('capture must never touch the network');
    }) as typeof fetch;

    try {
      const { session, db } = await harness();
      session.start();
      for (const role of ['label_photo', 'core_photo', 'site_photo'] as const) {
        await session.capturePhoto(role);
      }

      const result = await session.save({
        conditions: [{ condition_code: 'SOIL_MOIST', condition_value: 'moist' }],
        bags: [
          {
            bag_seq: 1,
            bag_role: 'composite',
            depth_top_cm: 0,
            depth_bottom_cm: 30,
            lab_id: 'lab-001',
            // Verbatim: lower case, stray space and all.
            barcode_raw: ' agi-0042-b ',
            barcode_symbology: 'CODE_128',
            barcode_capture_method: 'scan',
            barcode_scanned_ts: '2026-10-02T15:04:00Z',
            void_flag: false,
            void_reason_code: null,
          },
        ],
      });

      expect(result.media_ids).toHaveLength(3);
      // visit + sample + bag + condition + 3 media
      expect(result.queued).toBe(7);

      const outbox = await db.all<{ entity_type: string; depends_on: string | null; state: string }>(
        'SELECT entity_type, depends_on, state FROM outbox ORDER BY priority, outbox_id',
      );
      expect(outbox.map((r) => r.entity_type)).toEqual([
        'field_visit',
        'sample_point',
        'sample_bag',
        'sample_condition',
        'media_meta',
        'media_meta',
        'media_meta',
      ]);
      expect(outbox.every((r) => r.state === 'pending')).toBe(true);
      expect(outbox[1]!.depends_on).toBe('visit-0001');
      expect(outbox[4]!.depends_on).toBe(session.sample_uid);

      const bag = await db.all<{ barcode_raw: string }>('SELECT barcode_raw FROM sample_bag');
      expect(bag[0]!.barcode_raw).toBe(' agi-0042-b ');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('writes the fix, its spread and every sample it saw', async () => {
    const { session, db } = await harness();
    session.start();
    await session.save();

    const rows = await db.all<{
      position_source: string;
      gps_accuracy_m: number;
      fix_count: number;
      fix_spread_m: number;
      fix_samples_json: string;
      device_uptime_ms: number;
    }>('SELECT * FROM sample_point');
    const row = rows[0]!;
    expect(row.position_source).toBe('gps');
    expect(row.fix_count).toBe(3);
    expect(row.fix_spread_m).toBeGreaterThan(0);
    expect(JSON.parse(row.fix_samples_json)).toHaveLength(3);
    // Median of what the receiver claimed, not a figure shrunk by averaging.
    expect(row.gps_accuracy_m).toBe(5);
    expect(row.device_uptime_ms).toBe(123456);
  });

  it('keeps a dropped pin permanently distinct from a fix, with no accuracy', async () => {
    const { session, db } = await harness();
    session.start();
    session.dropPin(47.6, -99.2);
    await session.save();

    const rows = await db.all<{
      position_source: string;
      position_provider: string;
      gps_accuracy_m: number | null;
      fix_count: number;
      lat: number;
    }>('SELECT * FROM sample_point');
    const row = rows[0]!;
    expect(row.position_source).toBe('manual_map_pin');
    expect(row.position_provider).toBe('manual');
    expect(row.lat).toBe(47.6);
    expect(row.fix_count).toBe(0);
    // Not zero. Zero reads as a perfect measurement.
    expect(row.gps_accuracy_m).toBeNull();
  });

  it('flags a poor fix against the spec threshold rather than blocking the save', async () => {
    const { session, db } = await harness({
      fixes: [
        { lat: 47.5432, lon: -99.1234, accuracy: 25 },
        { lat: 47.5432, lon: -99.1234, accuracy: 25 },
        { lat: 47.5432, lon: -99.1234, accuracy: 25 },
      ],
    });
    session.start();

    const advisories = session.state().advisories.map((a) => a.code);
    expect(advisories).toContain('GPS_ACCURACY_EXCEEDED');
    // The threshold is the fixture spec's, not a constant in the app.
    expect(spec.gps_accuracy_required_m).toBe(10);
    expect(session.state().advisories[0]!.detail).toContain('10 m threshold');

    const result = await session.save();
    expect(result.sample_uid).toBe(session.sample_uid);
    const rows = await db.all('SELECT * FROM sample_point');
    expect(rows).toHaveLength(1);
  });

  it('saves a point with missing photographs and says what will be flagged', async () => {
    const { session, db } = await harness();
    session.start();
    await session.capturePhoto('label_photo');

    const result = await session.save();
    expect(result.advisories.map((a) => a.detail)).toContain('core_photo');
    expect(result.advisories.map((a) => a.detail)).toContain('site_photo');
    // Missing data flags; it does not drop (v02 §3).
    expect(await db.all('SELECT * FROM sample_point')).toHaveLength(1);
  });

  it('reports the advisory offset from the plan point without deciding anything', async () => {
    const { session } = await harness();
    session.start();
    const offset = session.state().offset_from_plan_m;
    expect(offset).not.toBeNull();
    expect(offset!).toBeLessThan(5);
  });

  it('refuses to invent a capture when there is no camera', async () => {
    const { session, db, blobs } = await harness({ cameraAvailable: false });
    session.start();

    const outcome = await session.capturePhoto('label_photo');
    expect(outcome).toEqual({ ok: false, reason: 'camera_unavailable', detail: 'no_camera' });
    expect(session.state().missing_required_roles).toContain('label_photo');
    expect(await blobs.list()).toEqual([]);

    await session.save();
    expect(await db.all('SELECT * FROM media')).toHaveLength(0);
  });
});

describe('v02 §11 criterion 11 — a gallery photograph cannot satisfy a required role', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
    h.session.start();
  });

  it('does not compile a required role into the gallery entry point', async () => {
    const file = new Blob([new Uint8Array([1, 2, 3])]);

    // @ts-expect-error — `addGalleryPhoto` takes `OptionalMediaRole`. If this
    // ever compiles, the structural guarantee is gone and `npm run typecheck`
    // fails on the unused expectation, which is the alarm.
    await h.session.addGalleryPhoto('label_photo', file);

    // @ts-expect-error — same for the other two required roles.
    await h.session.addGalleryPhoto('core_photo', file);

    // @ts-expect-error
    await h.session.addGalleryPhoto('site_photo', file);
  });

  it('refuses a required role at runtime before the file is even read', async () => {
    let read = 0;
    const file = {
      async arrayBuffer() {
        read += 1;
        return new Uint8Array([1, 2, 3]).buffer;
      },
    } as unknown as Blob;

    const outcome = await (
      h.session as unknown as {
        addGalleryPhoto(role: string, file: Blob): Promise<{ ok: boolean; reason?: string }>;
      }
    ).addGalleryPhoto('label_photo', file);

    expect(outcome).toEqual({ ok: false, reason: 'gallery_not_allowed_for_required_role' });
    // The intake boundary refused it. Nothing was read, nothing was hashed,
    // nothing was written — "we check it on submit" is the failure this is
    // written against.
    expect(read).toBe(0);
    expect(await h.blobs.list()).toEqual([]);
    expect(h.session.state().photos).toEqual([]);
    expect(h.session.state().missing_required_roles).toContain('label_photo');
  });

  it('produces no media row carrying a required role from the gallery path', async () => {
    const file = new Blob([new Uint8Array([9, 9, 9])]);
    await h.session.addGalleryPhoto('issue_photo', file);
    for (const role of ['label_photo', 'core_photo', 'site_photo'] as const) {
      await (
        h.session as unknown as { addGalleryPhoto(role: string, file: Blob): Promise<unknown> }
      ).addGalleryPhoto(role, file);
    }
    await h.session.save();

    const rows = await h.db.all<{
      media_role: string;
      capture_source: string;
      is_required_role: number;
    }>('SELECT media_role, capture_source, is_required_role FROM media');

    // One row: the optional one, permanently marked.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      media_role: 'issue_photo',
      capture_source: 'device_gallery',
      is_required_role: 0,
    });

    // The property, stated as the auditor would ask it: no row in this
    // database claims a required role on gallery-sourced bytes.
    const offending = rows.filter(
      (r) => r.capture_source !== 'in_app_camera' && r.is_required_role === 1,
    );
    expect(offending).toEqual([]);
  });

  it('marks a gallery photograph on an optional role and never counts it', async () => {
    const file = new Blob([new Uint8Array([7, 7, 7])]);
    const outcome = await h.session.addGalleryPhoto('other', file);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.photo.capture_source).toBe('device_gallery');

    expect(h.session.state().missing_required_roles).toEqual([
      'label_photo',
      'core_photo',
      'site_photo',
    ]);
  });
});
