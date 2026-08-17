/**
 * The tutorial photo path, asserted as a property of the **source tree** and of
 * the **compiler**, not of one function's behaviour.
 *
 * `tutorial.test.ts` proves the tutorial works. That is necessary and it is not
 * sufficient. The requirement is that a tutorial photograph is *structurally
 * incapable* of attaching to a real plan point — the same standard v02 §11
 * criterion 11 sets for a gallery photograph, and for the same reason: the
 * person reading `MEDIA` in 2029 cannot check what the app did, only what the
 * app could have done.
 *
 * Five independent barriers, each checked here, each of which alone would be
 * enough and none of which is relied on alone:
 *
 *  1. **The compiler.** `'tutorial_synthetic'` is not a `CaptureSource`, so a
 *     `TutorialImage` cannot become a `MediaMetaPayload` and a
 *     `TutorialMediaRecord` cannot become a `StoredMedia`.
 *  2. **The class identity.** `mode` is a literal on both sessions, so neither
 *     is assignable to the other.
 *  3. **The absence of a database.** Nothing under `tutorial/` can reach
 *     SQLite, the outbox or OPFS. Checked by scanning the source.
 *  4. **The reserved identifier namespace**, refused by the production
 *     `CaptureSession` constructor and by `writeCaptureLocally` before its
 *     transaction opens.
 *  5. **One minting site**, mirroring the check that already guards
 *     `in_app_camera` and `device_gallery`.
 *
 * The existing criterion-11 checks in `../structural-guarantee.test.ts` and
 * `../session.test.ts` are deliberately untouched by this wave. Nothing here
 * replaces them.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import bundleFixture from '../../../../fixtures/bundle.f26-demo.json';
import { NodeSqliteDb } from '../../../../tests/support/node-sqlite.js';
import { bootstrapDeviceDb } from '../../../shared/db/schema.js';
import type { AssignmentBundle } from '../../../shared/contract/bundle.js';
import type { CaptureSource, PositionSource } from '../../../shared/contract/common.js';
import type { SamplePointPayload } from '../../../shared/contract/entities.js';
import { attachRequiredRole, attachToRole } from '../camera/intake.js';
import { webCryptoHasher, type ProcessOptions } from '../camera/pipeline.js';
import { MemoryMediaBlobStore } from '../media-blobs.js';
import { CaptureSession, type CaptureSpec } from '../session.js';
import { writeCaptureLocally, type StoredMedia } from '../save.js';
import { TutorialLeakError } from '../tutorial-boundary.js';
import { intakeSyntheticImage, type TutorialImage } from './synthetic.js';
import { scriptedTutorialGeolocation } from './scripted-gps.js';
import { TutorialCaptureSession, type TutorialMediaRecord } from './session.js';
import * as tutorialApi from './index.js';

const SRC_ROOT = fileURLToPath(new URL('../../../../src', import.meta.url));
const CAPTURE_ROOT = path.join(SRC_ROOT, 'app', 'capture');
const TUTORIAL_ROOT = path.join(CAPTURE_ROOT, 'tutorial');

const bundle = bundleFixture as unknown as AssignmentBundle;
const spec = bundle.specs[0] as CaptureSpec;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const ALL_SOURCES = sourceFiles(SRC_ROOT);

function relative(file: string): string {
  return path.relative(SRC_ROOT, file).split(path.sep).join('/');
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
    exif: {
      async parse() {
        return { lat: null, lon: null, ts: null, raw: null };
      },
    },
    hasher: webCryptoHasher,
  };
}

async function tutorialImage(): Promise<TutorialImage> {
  return intakeSyntheticImage(
    {
      bytes: new TextEncoder().encode('drawn'),
      natural_width: 2400,
      natural_height: 1800,
      scene: 'soil core',
    },
    imaging(),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 · The compiler
// ─────────────────────────────────────────────────────────────────────────────

describe('a tutorial image cannot become a media row', () => {
  it('is not accepted by the function that attaches a required role', async () => {
    const image = await tutorialImage();
    const context = { device_id: 'dev-0001' };

    // @ts-expect-error - a TutorialImage is not a CameraImage. Widening this
    // parameter to accept one is the bug this directive exists to catch.
    void (() => attachRequiredRole('label_photo', image, context));

    // @ts-expect-error - nor is it an IntakeImage, so the dynamic entry point
    // cannot take it either, for a required role or an optional one.
    void (() => attachToRole('issue_photo', image, context));

    // And the runtime agrees, for the JavaScript caller and for `as`.
    expect(() =>
      attachRequiredRole('label_photo', image as never, context),
    ).toThrow(/in-app camera images only/);
    expect(attachToRole('site_photo', image as never, context)).toEqual({
      ok: false,
      reason: 'gallery_not_allowed_for_required_role',
    });
  });

  it('cannot be widened into the payload the local writer accepts', () => {
    const record: TutorialMediaRecord = {
      media_id: 'tutorial-media-1',
      content_hash: 'a'.repeat(64),
      sample_uid: 'tutorial-sample-1',
      media_role: 'label_photo',
      is_required_role: true,
      capture_order: 1,
      capture_ts_device: '2026-10-02T15:00:00.000Z',
      exif_lat: null,
      exif_lon: null,
      exif_ts: null,
      exif_gps_present: false,
      bytes: 1,
      width_px: 1920,
      height_px: 1440,
      mime_type: 'image/jpeg',
      capture_source: 'tutorial_synthetic',
      is_tutorial: true,
    };

    // @ts-expect-error - StoredMedia.payload is a MediaMetaPayload, whose
    // capture_source is CaptureSource. There is no assignment that gets a
    // tutorial record into the only shape writeCaptureLocally will write.
    const stored: StoredMedia = { payload: record, local_path: 'media/a.jpg' };
    void stored;
    expect(record.capture_source).toBe('tutorial_synthetic');
  });

  it('keeps tutorial_synthetic out of the wire contract entirely', () => {
    // @ts-expect-error - if someone adds it to CaptureSource, this directive
    // goes unused and the build fails. That is the intended alarm: the value
    // becoming representable on the wire is the whole thing to prevent.
    const source: CaptureSource = 'tutorial_synthetic';
    void source;

    // @ts-expect-error - same for the position union. A simulated receiver
    // must not be able to write sample_point.position_source.
    const provenance: PositionSource = 'tutorial_simulated_gps';
    void provenance;

    // @ts-expect-error - and for the dropped pin, which stays a separate value
    // inside the sandbox too.
    const pin: PositionSource = 'tutorial_manual_map_pin';
    void pin;
  });

  it('keeps the tutorial sample record out of SamplePointPayload', () => {
    const sample = {
      sample_uid: 'tutorial-sample-1',
      position_source: 'tutorial_simulated_gps' as const,
    };
    // @ts-expect-error - position_source is not a PositionSource, so the
    // tutorial's own record shape is not a sample_point payload either.
    const payload: Pick<SamplePointPayload, 'sample_uid' | 'position_source'> = sample;
    void payload;
    expect(sample.position_source).toBe('tutorial_simulated_gps');
  });
});

/**
 * Never called. Typed parameters give the compiler two real values to reject
 * without either session having to be constructed, and a failure here is a
 * `tsc` failure, not a test failure — which is the point: it fails the build
 * even for someone who only runs `npm run typecheck`.
 */
function sessionsAreNotInterchangeable(
  production: CaptureSession,
  tutorial: TutorialCaptureSession,
): void {
  // @ts-expect-error - mode is 'tutorial', not 'production'. A screen typed on
  // CaptureSession cannot be handed the tutorial one.
  const a: CaptureSession = tutorial;
  // @ts-expect-error - and not the other way round either.
  const b: TutorialCaptureSession = production;
  void a;
  void b;
}

describe('the two sessions are different types', () => {
  it('does not let one stand in for the other', () => {
    expect(typeof sessionsAreNotInterchangeable).toBe('function');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 · No database, anywhere under tutorial/
// ─────────────────────────────────────────────────────────────────────────────

describe('the tutorial path has nothing to write to', () => {
  const TUTORIAL_SOURCES = sourceFiles(TUTORIAL_ROOT);

  /**
   * Import statements only, never prose.
   *
   * Scanning for bare identifiers would flag the file headers that *explain*
   * the guarantee — "`TutorialCaptureSessionOptions` has no `SqlDatabase`
   * field" would fail a check for `SqlDatabase` — and a rule that punishes
   * documenting itself gets the documentation deleted, not the rule.
   */
  function importsOf(file: string): Array<{ names: string; specifier: string }> {
    const source = readFileSync(file, 'utf8');
    const out: Array<{ names: string; specifier: string }> = [];
    const pattern = /import\s+([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g;
    for (const match of source.matchAll(pattern)) {
      out.push({ names: match[1] ?? '', specifier: match[2] ?? '' });
    }
    return out;
  }

  it('covers every file in the directory', () => {
    expect(TUTORIAL_SOURCES.length).toBeGreaterThanOrEqual(5);
  });

  it('imports nothing that can reach SQLite, the outbox or a server', () => {
    const forbidden = /(shared\/db|sync\/|server\/|\/save\.js|capture\/save)/;
    const offenders = TUTORIAL_SOURCES.flatMap((file) =>
      importsOf(file)
        .filter((imp) => forbidden.test(imp.specifier))
        .map((imp) => `${relative(file)} -> ${imp.specifier}`),
    );
    expect(offenders).toEqual([]);
  });

  it('takes only the two URL helpers from the blob store, never the OPFS one', () => {
    const offenders = TUTORIAL_SOURCES.flatMap((file) =>
      importsOf(file)
        .filter((imp) => /media-blobs/.test(imp.specifier))
        .flatMap((imp) =>
          imp.names
            .replace(/[{}]/g, '')
            .split(',')
            .map((n) => n.trim())
            .filter((n) => n.length > 0 && !['objectUrlFor', 'revokeObjectUrl'].includes(n))
            .map((n) => `${relative(file)} -> ${n}`),
        ),
    );
    expect(offenders).toEqual([]);
  });

  it('takes only types from the production session module', () => {
    const offenders = TUTORIAL_SOURCES.flatMap((file) =>
      importsOf(file)
        .filter((imp) => /\.\.\/session\.js$/.test(imp.specifier))
        .filter((imp) => !/^type\s/.test(imp.names.replace(/[{}]/g, '').trim()))
        .map((imp) => `${relative(file)} -> ${imp.specifier}`),
    );
    expect(offenders).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 · The reserved namespace, refused on the production path
// ─────────────────────────────────────────────────────────────────────────────

describe('the production capture path refuses tutorial identifiers', () => {
  function productionSession(overrides: { visit_id?: string; plan_point_id?: string | null }) {
    return new CaptureSession({
      db: new NodeSqliteDb(),
      spec,
      visit_id: overrides.visit_id ?? 'visit-0001',
      plan_point_id: overrides.plan_point_id ?? 'pp-001',
      device_id: 'dev-0001',
      blobs: new MemoryMediaBlobStore(),
      imaging: imaging(),
      geolocation: { watchPosition: () => 1, clearWatch: () => {} },
    });
  }

  it('throws in the constructor on a tutorial plan point, before any GPS or camera', () => {
    expect(() => productionSession({ plan_point_id: 'tutorial-point-PT-001' })).toThrow(
      TutorialLeakError,
    );
  });

  it('throws in the constructor on a tutorial visit', () => {
    expect(() => productionSession({ visit_id: 'tutorial-visit-abc' })).toThrow(TutorialLeakError);
  });

  it('still builds for an ordinary plan point', () => {
    expect(() => productionSession({})).not.toThrow();
  });

  it('refuses at the writer, and writes nothing when it does', async () => {
    const db = new NodeSqliteDb();
    await bootstrapDeviceDb(db);

    const sample: SamplePointPayload = {
      sample_uid: 'tutorial-sample-0001',
      visit_id: 'visit-0001',
      plan_point_id: null,
      lat: 47.5432,
      lon: -99.1234,
      gps_accuracy_m: 4,
      altitude_m: null,
      altitude_accuracy_m: null,
      position_provider: 'gps',
      position_source: 'gps',
      fix_count: 3,
      fix_spread_m: 1,
      fix_samples_json: '[]',
      deviation_reason_code: null,
      captured_ts_device: '2026-10-02T15:00:00.000Z',
      captured_ts_utc_offset: 0,
      device_uptime_ms: null,
      sampler_person_id: null,
      device_id: 'dev-0001',
      period_code: 'F26',
      spec_id: spec.spec_id,
      protocol_version: 'BCARBON_V3.0',
      depth_achieved_cm: null,
      refusal_code: null,
      cores_taken: null,
      bd_core_taken: null,
      note: null,
      supersedes_sample_uid: null,
    };

    await expect(writeCaptureLocally(db, { sample })).rejects.toThrow(TutorialLeakError);

    // Refused outside the transaction, so there is no partial row to reason
    // about — the state after the throw is the state before the call.
    const points = await db.all<{ n: number }>('SELECT COUNT(*) AS n FROM sample_point');
    const outbox = await db.all<{ n: number }>('SELECT COUNT(*) AS n FROM outbox');
    expect(Number(points[0]?.n)).toBe(0);
    expect(Number(outbox[0]?.n)).toBe(0);
  });
});

describe('a completed tutorial leaves the device database untouched', () => {
  it('writes no sample, no media and no outbox entry', async () => {
    const db = new NodeSqliteDb();
    await bootstrapDeviceDb(db);

    const session = new TutorialCaptureSession({
      spec,
      imaging: imaging(),
      images: {
        async render(role) {
          return {
            bytes: new TextEncoder().encode(`drawn:${role}`),
            natural_width: 2400,
            natural_height: 1800,
            scene: role,
          };
        },
      },
      geolocation: scriptedTutorialGeolocation({
        schedule: (fn: () => void) => {
          fn();
          return 0;
        },
        cancel: () => {},
      }),
    });

    session.start();
    for (const role of spec.required_media_roles) await session.capturePhoto(role);
    const result = await session.save();
    session.discard();

    expect(result.media).toHaveLength(3);
    expect(result.rows_written).toBe(0);

    for (const table of ['sample_point', 'media', 'sample_bag', 'sample_condition', 'outbox']) {
      const rows = await db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
      expect(Number(rows[0]?.n), `${table} should be empty`).toBe(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5 · One minting site, and one door
// ─────────────────────────────────────────────────────────────────────────────

describe('tutorial_synthetic is minted in exactly one place', () => {
  it('has one site that stamps it onto bytes', () => {
    const minting = ALL_SOURCES.filter((file) =>
      /capture_source:\s*'tutorial_synthetic'/.test(readFileSync(file, 'utf8')),
    ).map(relative);

    expect(minting).toEqual(['app/capture/tutorial/synthetic.ts']);
  });

  it('does not appear in the wire contract or anywhere else under shared/', () => {
    const offenders = ALL_SOURCES.filter(
      (file) =>
        relative(file).startsWith('shared/') && /tutorial_synthetic/.test(readFileSync(file, 'utf8')),
    ).map(relative);

    expect(offenders).toEqual([]);
  });

  it('is not reachable from outside the capture path', () => {
    const importsSynthetic = /from\s+['"][^'"]*capture\/tutorial\/synthetic(\.js)?['"]/;
    const importers = ALL_SOURCES.filter((file) => {
      if (file.startsWith(CAPTURE_ROOT)) return false;
      return importsSynthetic.test(readFileSync(file, 'utf8'));
    }).map(relative);

    expect(importers).toEqual([]);
  });

  it('does not re-export the minting function from the tutorial barrel', () => {
    expect(Object.keys(tutorialApi)).not.toContain('intakeSyntheticImage');
    expect(Object.keys(tutorialApi)).not.toContain('intakeFromCamera');
    expect(Object.keys(tutorialApi)).not.toContain('processImage');
  });

  it('publishes a declared surface, so widening it is a deliberate diff', () => {
    expect(Object.keys(tutorialApi).sort()).toEqual(
      [
        'TUTORIAL_GPS_TRACK',
        'TUTORIAL_ID_PREFIX',
        'TUTORIAL_NOTICE',
        'TUTORIAL_PLAN_POINT',
        'TUTORIAL_SPEC',
        'TUTORIAL_WATERMARK',
        'TutorialCaptureSession',
        'TutorialLeakError',
        'canvasSyntheticImages',
        'capturePhotoView',
        'createTutorialCaptureSession',
        'isTutorialId',
        'scriptedTutorialGeolocation',
      ].sort(),
    );
  });
});
