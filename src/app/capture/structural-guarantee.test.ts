/**
 * v02 §11 criterion 11, asserted as a property of the **source tree** rather
 * than of one function's behaviour.
 *
 * `session.test.ts` proves that the gallery path refuses a required role.
 * That is necessary and it is not sufficient: the criterion says a gallery
 * photograph *cannot* satisfy a required role, and "cannot" is a statement
 * about every path that exists, including ones written next year by someone
 * who never read this file.
 *
 * Three tripwires:
 *
 *  1. **One minting site.** `capture_source: 'in_app_camera'` is written in
 *     exactly one place. Everywhere else the value is carried, never claimed.
 *  2. **One door.** Only files inside `src/app/capture/` may import the
 *     minting function. A screen that imports it directly can stamp
 *     `in_app_camera` onto bytes from anywhere, and no type stops it — which
 *     is exactly what the exception below records.
 *  3. **A declared public surface.** The barrel's exports are enumerated, so
 *     widening the capture path's API is a deliberate edit with a diff, not a
 *     side effect of adding an export somewhere.
 *
 * These are cheap and they are the only checks that keep holding after the
 * people who agreed to the rule have left.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as captureApi from './index.js';

const SRC_ROOT = fileURLToPath(new URL('../../../src', import.meta.url));
const CAPTURE_ROOT = path.join(SRC_ROOT, 'app', 'capture');

/**
 * Files outside `src/app/capture/` that import the minting function today.
 *
 * **This list should be empty and is not.** `pwa-screens` built Screen 3's
 * photo tiles against `intakeFromCamera` directly during the same wave this
 * check was written, before `CaptureSession` existed to build against. Its
 * `CameraTile` is honest — it opens `getUserMedia` and offers no file picker
 * — but its `onCapture(bytes: Uint8Array)` prop is typed on bytes, so the
 * provenance is a convention held by one component rather than a property of
 * the capture path. Migration is one request in
 * `integration/requests-b.md`; deleting this entry is how it closes.
 *
 * Additions fail the test. Removals do not — closing the gap must never be
 * the thing that turns the tree red.
 */
const DECLARED_DIRECT_IMPORTERS: readonly string[] = ['app/screens/capture/CaptureScreen.tsx'];

/**
 * Every shipping `.ts`/`.tsx` file under `src/`.
 *
 * Test files are excluded: a test that asserts a gallery photograph is marked
 * `device_gallery` has to write the string, and counting it as a minting site
 * would make the check punish the thing that proves the rule.
 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const ALL_SOURCES = sourceFiles(SRC_ROOT);

function relative(file: string): string {
  return path.relative(SRC_ROOT, file).split(path.sep).join('/');
}

describe('capture_source is minted in exactly one place', () => {
  it('has one site that stamps in_app_camera onto bytes', () => {
    const minting = ALL_SOURCES.filter((file) => {
      if (file.endsWith('index.ts') && file.startsWith(CAPTURE_ROOT)) return false; // the barrel quotes it in prose
      return /capture_source:\s*'in_app_camera'/.test(readFileSync(file, 'utf8'));
    }).map(relative);

    expect(minting).toEqual(['app/capture/camera/intake.ts']);
  });

  it('has one site that stamps device_gallery, and it is a different function', () => {
    const minting = ALL_SOURCES.filter((file) =>
      /capture_source:\s*'device_gallery'/.test(readFileSync(file, 'utf8')),
    ).map(relative);

    expect(minting).toEqual(['app/capture/camera/intake.ts']);
  });
});

describe('the camera intake has one door', () => {
  it('is imported only from inside the capture path, plus the declared exceptions', () => {
    // An `import … from '…/capture/camera/intake.js'`, not a mention of the
    // name in prose — several files reference it correctly in a comment.
    const importsIntake = /from\s+['"][^'"]*capture\/camera\/intake(\.js)?['"]/;
    const importers = ALL_SOURCES.filter((file) => {
      if (file.startsWith(CAPTURE_ROOT)) return false;
      return importsIntake.test(readFileSync(file, 'utf8'));
    }).map(relative);

    const undeclared = importers.filter((file) => !DECLARED_DIRECT_IMPORTERS.includes(file));
    expect(undeclared).toEqual([]);
  });

  it('does not re-export the minting functions from the barrel', () => {
    const exported = Object.keys(captureApi);
    expect(exported).not.toContain('intakeFromCamera');
    expect(exported).not.toContain('intakeFromGallery');
    expect(exported).not.toContain('attachRequiredRole');
    expect(exported).not.toContain('processImage');
  });
});

describe('the capture path publishes a declared surface', () => {
  it('exports exactly what screens are meant to use', () => {
    // Runtime exports only — types are erased and are listed in the report.
    expect(Object.keys(captureApi).sort()).toEqual(
      [
        'CameraUnavailableError',
        'CaptureSession',
        'GpsAcquisition',
        'JPEG_QUALITY',
        'LONG_EDGE_PX',
        'LiveCameraSource',
        'MemoryMediaBlobStore',
        'OpfsMediaBlobStore',
        'REQUIRED_ROLES',
        'advisoryOffsetFromPlan',
        'browserImaging',
        'createCaptureSession',
        'exifrParser',
        'isRequiredRole',
        'manualPinCapture',
        'mediaLocalPath',
        'missingRequiredRoles',
        'objectUrlFor',
        'revokeObjectUrl',
        'targetSize',
        'writeCaptureLocally',
      ].sort(),
    );
  });

  it('names the three required roles from the spec, not from a screen', () => {
    expect(captureApi.REQUIRED_ROLES).toEqual(['label_photo', 'core_photo', 'site_photo']);
    for (const role of captureApi.REQUIRED_ROLES) {
      expect(captureApi.isRequiredRole(role)).toBe(true);
    }
    expect(captureApi.isRequiredRole('issue_photo')).toBe(false);
    expect(captureApi.isRequiredRole('other')).toBe(false);
  });
});
