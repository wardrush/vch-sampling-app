# capture-integrity — wave 3

**Task:** a tutorial-only photo path, so the intended user flow can be demonstrated
on a machine with no camera, without weakening v02 §11 criterion 11 by an inch.

**Answer: it can be built honestly, and it is built.** Nothing about the production
path changed. The tutorial is a second object behind a second door, and it is
structurally incapable of reaching a real plan point — five independent barriers,
each verified to fail when removed.

**Gate:** `npm run typecheck` → **clean** · `npm test` → **33 files · 333 passed · 1
skipped (334)** · **0 failed**. My four capture test files contribute 53 of those
(`session.test.ts` 15, `structural-guarantee.test.ts` 6, `tutorial/tutorial.test.ts`
13, `tutorial/separation.test.ts` 19). Ran against a tree `pwa-screens` was still
writing to — FLEET.md §4.5, the authoritative run is `fleet-integrator`'s.

**My wave-2 tests were not modified.** Neither was `src/app/capture/index.ts`,
including its enumerated export list. That was a constraint I took literally and it
turned out to improve the design: see "Why a second door" below.

---

## The interface `pwa-screens` consumes

**Import from `@app/capture/tutorial/index.js`.** It is a *separate* barrel from
`@app/capture/index.js`, which is unchanged. A screen's import line therefore says
which branch it is on, visibly, in the diff.

```ts
import {
  createTutorialCaptureSession, capturePhotoView,
  TUTORIAL_PLAN_POINT, TUTORIAL_NOTICE, TUTORIAL_WATERMARK, isTutorialId,
  type TutorialCaptureSessionState, type TutorialAttachedPhoto,
  type TutorialCaptureResult, type CapturePhotoView,
} from '@app/capture/tutorial/index.js';

// ── construct once, at mount. No db, no blob store, no camera, no permissions ──
const session = createTutorialCaptureSession({
  spec,        // OPTIONAL CaptureSpec. Pass the bundle's real spec if the device
               // has one — then the tutorial teaches the project's actual
               // thresholds. Omitted → TUTORIAL_SPEC (model data).
  planPoint,   // OPTIONAL TutorialPlanPoint. Omitted → TUTORIAL_PLAN_POINT.
  // also optional, all defaulted: imaging (canvas+exifr+WebCrypto, same as prod),
  // images (watermarked OffscreenCanvas renderer), geolocation (scripted track),
  // now, newId
});

session.mode;         // 'tutorial'  — CaptureSession.mode is 'production'
session.sample_uid;   // 'tutorial-sample-<uuidv7>'
session.plan_point;   // TutorialPlanPoint (label, property_name, planned lat/lon)

// ── same lifecycle as CaptureSession ────────────────────────────────────────
useEffect(() => { session.start(); return () => session.stop(); }, []);
const unsubscribe = session.subscribe((s: TutorialCaptureSessionState) => setState(s));

// ── photographs: no camera involved, works headless ─────────────────────────
await session.capturePhoto('label_photo');   // any MediaRole, incl. required ones
// → { ok: true; photo: TutorialAttachedPhoto }
// | { ok: false; reason: 'render_failed' | 'already_saved'; detail?: string }
session.removePhoto(mediaId);                // sync, not async

// ── position: identical semantics, tutorial-branded values ──────────────────
session.dropPin(lat, lon);           // 'tutorial_manual_map_pin'
session.clearPin();                  // back to 'tutorial_simulated_gps'
session.setDeviationReason(code);

// ── finish: writes NOTHING. Returns the record that would have existed ──────
const result: TutorialCaptureResult = await session.save({
  note, depth_achieved_cm, cores_taken,
  bag_count,        // for the "would have queued N" line only
  condition_count,
});
// → { discarded: true, rows_written: 0, would_queue: number,
//     sample: TutorialSampleRecord, media: TutorialMediaRecord[],
//     advisories: CaptureAdvisory[], notice: string }

session.discard();                   // frees preview URLs, stops the receiver
```

`TutorialCaptureSessionState`, which is what the tutorial screen renders:

```ts
interface TutorialCaptureSessionState {
  mode: 'tutorial';
  sample_uid: string;                     // tutorial-branded
  plan_point: TutorialPlanPoint;
  gps: GpsState;                          // the SAME GpsState the real screen renders
  position: TutorialPosition | null;      // position_source:
                                          //   'tutorial_simulated_gps' | 'tutorial_manual_map_pin'
  offset_from_plan_m: number | null;      // model data lands this at 18.3 m — amber
  photos: TutorialAttachedPhoto[];        // capture_source: 'tutorial_synthetic'
  missing_required_roles: MediaRole[];    // the three tiles' unsatisfied state
  deviation_reason_code: string | null;
  advisories: CaptureAdvisory[];          // same DEFECT_CODE values as production
  saved: boolean;
  notice: string;                         // TUTORIAL_NOTICE — put this in a banner
  watermark_text: string;                 // TUTORIAL_WATERMARK
}
```

### For the photo tile, use `capturePhotoView` for both branches

```ts
capturePhotoView(photo: AttachedPhoto | TutorialAttachedPhoto): CapturePhotoView
// { media_id, media_role, preview_url, bytes, width_px, height_px,
//   provenance_label, provenance_tone: 'neutral' | 'warning' | 'tutorial',
//   is_tutorial }
```

It is total over both photo types and discriminates on the `capture_source` the
intake minted, **not** on a flag the caller passes. There is no argument to it that
makes a tutorial photograph render as a camera one. Render `provenance_label`
under every thumbnail and make `tutorial` conspicuous; that is requirement 3's
on-screen half, and putting it here means a second tile component written next year
cannot forget it.

### Two shapes you will find are deliberately *not* interchangeable

- `TutorialCaptureSession` is **not** assignable to `CaptureSession` (`mode` is a
  literal on both). `CaptureCameraPanel`'s `session: CaptureSession` prop will
  correctly reject it. The tutorial session has no camera at all — no
  `openCamera`, no `cameraView`, no `closeCamera` — so there is nothing for that
  panel to do; render the tiles straight from `state.photos`.
- `TutorialAttachedPhoto` is **not** assignable to `AttachedPhoto`. Keep them in
  separate arrays, or convert both with `capturePhotoView`.

If either bites, that is the barrier working. **Tell me and I will export the shape
— do not widen it from the screen side.**

---

## What landed

| File | What it does |
|---|---|
| `src/app/capture/tutorial-boundary.ts` | The line, on the **production** side of it. `TUTORIAL_ID_PREFIX`, `isTutorialId`, `TutorialLeakError`, `assertNoTutorialIdentity`, and the two type aliases the tutorial brands itself with. Imports nothing from `tutorial/` — a one-way dependency, so deleting the tutorial directory would leave the production guarantees standing. |
| `src/app/capture/tutorial/synthetic.ts` | The drawn photograph. **The one site that mints `tutorial_synthetic`.** Watermarked `OffscreenCanvas` renderer, injectable; runs the frame through the *real* `processImage` (1920 px, q≈0.72, SHA-256). |
| `src/app/capture/tutorial/scripted-gps.ts` | A `GeolocationLike` replaying a five-fix track on a timer, fed to the unmodified `GpsAcquisition`. |
| `src/app/capture/tutorial/model-data.ts` | The model plan point, the fallback spec, the track. |
| `src/app/capture/tutorial/session.ts` | `TutorialCaptureSession`. No db, no blob store, no camera. |
| `src/app/capture/tutorial/photo-view.ts` | `capturePhotoView`, total over both photo types. |
| `src/app/capture/tutorial/index.ts` | The tutorial door. Declared surface, enumerated. |
| `src/app/capture/session.ts` | **+2 changes:** `readonly mode = 'production'`, and `assertNoTutorialIdentity` in the constructor. |
| `src/app/capture/save.ts` | **+1 change:** `assertNoTutorialWrite` before the transaction opens. |
| `src/app/capture/tutorial/tutorial.test.ts` | 13 tests — behaviour. |
| `src/app/capture/tutorial/separation.test.ts` | 19 tests — the structural guarantee. |

---

## 1 · Criterion 11 did not move

All four wave-2 layers are byte-identical and all their tests pass unmodified.
Nothing in this wave touched `camera/intake.ts`, `camera/types.ts`,
`camera/source.ts`, `camera/pipeline.ts`, `index.ts`, `session.test.ts` or
`structural-guarantee.test.ts`.

The two edits to `session.ts` and `save.ts` are both **additional refusals**. Neither
relaxes a condition; each adds a throw on a case that previously proceeded.

I re-ran the wave-2 tripwire the obvious way: I set `TutorialImage.capture_source`
to `'in_app_camera'`. **Layer 1 and layer 3 both caught it** —
`structural-guarantee.test.ts` failed with two minting sites, and `tsc` failed with
two `TS2578 Unused '@ts-expect-error'` errors plus two `TS2322`s. Reverted.

---

## 2 · Why a tutorial photo cannot reach a real plan point

Five barriers. Each alone would be sufficient; none is relied on alone.

**1 · The compiler, at the type of the photograph.** `'tutorial_synthetic'` is
**deliberately absent from `CaptureSource`** in `src/shared/contract/common.ts`.
That absence is the guarantee, not an omission to tidy up later. Because the value
does not exist in that union:

- `attachToRole` / `attachRequiredRole` will not take a `TutorialImage` — proved by
  two `@ts-expect-error` directives;
- `toPayload` cannot construct a `MediaMetaPayload` from one;
- `StoredMedia.payload` cannot hold a `TutorialMediaRecord` — proved by a third;
- `writeCaptureLocally` writes nothing else.

This is strictly stronger than the gallery/required-role separation, where the two
brands at least share the `IntakeImage` union. Here they share nothing.

There is a fourth directive asserting `const x: CaptureSource = 'tutorial_synthetic'`
is an error. **If anyone adds the value to the wire union, that directive goes
unused and the build fails.** The alarm is deliberately pointed at the change most
likely to look like a tidy-up.

**2 · The compiler, at the type of the session.** `mode` is a literal on both
classes, so neither is assignable to the other. Asserted by a never-called function
with two typed parameters — so it fails `npm run typecheck`, not just `npm test`.

**3 · No database handle.** `TutorialCaptureSessionOptions` has no `SqlDatabase`
and no `MediaBlobStore`. `separation.test.ts` parses the import statements of every
file under `tutorial/` and fails if any resolves to `shared/db`, `sync/`, `server/`
or `save.js`; it also checks that the only names taken from `media-blobs.js` are
`objectUrlFor` and `revokeObjectUrl` (never the OPFS store), and that the
production `session.js` is imported `type`-only. *Import statements, never bare
identifiers* — a scan for the word `SqlDatabase` would flag the file header that
explains the guarantee, and a rule that punishes documenting itself gets the
documentation deleted rather than the rule.

**4 · A reserved identifier namespace.** Every id the tutorial mints is prefixed
`tutorial-`. Refused by `assertNoTutorialIdentity` in the production
`CaptureSession` **constructor** — before the GPS watch, before a camera, before a
byte — and again in `writeCaptureLocally` **before the transaction opens**, so the
state after a refusal is the state before the call. A prefix rather than a boolean
column because a boolean is a claim a row makes about itself that nobody in 2029 can
check; `tutorial-sample-0192f…` is self-describing in a bare `SELECT`, in a CSV
extract, and in a screenshot.

**5 · One minting site**, scanned for exactly as `in_app_camera` and
`device_gallery` already are, plus a check that the string appears nowhere under
`src/shared/`, plus a check that nothing outside `src/app/capture/` imports
`tutorial/synthetic.js`, plus an enumerated export list on the tutorial barrel.

### Each of these was verified by removing it

| Removed | Result |
|---|---|
| `TutorialImage`'s own brand (set to `in_app_camera`) | `tsc`: 2× `TS2578`, 2× `TS2322`. `structural-guarantee.test.ts` (wave 2) and `separation.test.ts` both fail |
| `assertNoTutorialIdentity` from the `CaptureSession` constructor | 2 tests fail |
| `assertNoTutorialWrite` from `writeCaptureLocally` | 1 test fails, on the assertion that nothing was written |

All three reverted; the tree is as reported.

---

## 3 · Verified in a real headless browser, not argued

Built the tutorial path with Vite, served it on `127.0.0.1`, drove it with the
Chromium at `/opt/pw-browsers/chromium-1194/…`. I did **not** write in
`tests/e2e/**` — that is `pwa-screens`' this wave — and I did not run
`npx playwright install`.

```
getUserMedia            REJECTED — NotFoundError: Requested device not found
```

That is the condition the whole thing exists for, confirmed rather than assumed. On
that same page, in that same browser:

**The production path behaved exactly as wave 2 says it must.**

```
production_capture        { ok: false, reason: 'camera_unavailable', detail: 'no_camera' }
production_missing_roles  [ 'label_photo', 'core_photo', 'site_photo' ]
production_photos         0
```

A failed camera on a real sample still leaves all three roles visibly unsatisfied
and writes nothing. Requirement 4, demonstrated on the machine most likely to break
it.

**The tutorial path completed.**

```
3 photos, all 1920×1440, 127–179 KB, sha256 present, capture_source tutorial_synthetic
media_id                  tutorial-media-01a0114b-…
tutorial_missing_roles    []
provenance_label          "TUTORIAL — synthetic image, not evidence"   tone: tutorial

gps   fixes 5 · accuracyM 7 · meetsSpec true · spread 49.6 m
      position_source 'tutorial_simulated_gps'  provider 'tutorial_simulated'
      offset_from_plan_m 18.3            ← past warn (15), short of block (30)

save  discarded true · rows_written 0 · would_queue 8 · media 3
      sample_uid      tutorial-sample-01a0114b-…
      plan_point_id   tutorial-point-PT-001
      position_source tutorial_simulated_gps
```

The dimensions and byte counts are real, because the synthetic frame goes through
the same `processImage` — so the storage arithmetic the demo shows is v02 §4.4's,
not a placeholder.

I decoded a produced JPEG and looked at it. The watermark is burnt into the pixels:
a solid banner top (`TUTORIAL — NOT FIELD EVIDENCE`) and bottom (`EXAMPLE DATA —
DISCARDED ON EXIT`), plus diagonal repeats across the frame so a crop cannot lose
it. The core-photo scene renders as soil horizons against a 0–30 cm rule; the label
scene says `MODEL LABEL — NOT A REAL BARCODE` under a bar pattern with no start/stop
guard, so it will not decode.

**A badge in the UI is a property of the screen that rendered it. A screenshot
pasted into an email in 2027 is not.** That is why the marking is in the bytes that
are hashed, and why it travels with the image.

---

## Decisions, and what each one costs

**Why a second door rather than widening `@app/capture/index.js`.** Adding tutorial
exports to the production barrel is the first step towards a screen reaching for a
tutorial image inside a production session. A separate module makes the branch
visible in the import line. It also meant the wave-2 declared-surface test passed
completely unmodified, which is the check the brief asked me to preserve.

**Why the tutorial has no camera at all**, not even when one exists. It is not a
fallback and must not become one by accident. If it opened a real camera when one
was available, the demo would be non-deterministic, would cost a permission prompt,
and — worse — there would be two kinds of tutorial photograph, one of which came off
a real sensor. One kind, always drawn, always watermarked.

**Why the tutorial's GPS is real code.** `scriptedTutorialGeolocation` implements
`GeolocationLike` and is fed to the unmodified `GpsAcquisition`, so the tutorial
exercises the real inverse-variance weighting, the real median-of-claimed-accuracy
rule (the accuracy is **not** shrunk by averaging), and the real spread. What the
sampler watches on the accuracy chip is the code that will run in the field.

**Why there are two tutorial position sources, not one.** A satellite fix and a
dropped pin are different things, and that holds inside the sandbox too — a tutorial
that blurred them would be teaching the wrong lesson on the one distinction v02 §9
is least willing to lose. So `tutorial_simulated_gps` and
`tutorial_manual_map_pin`. Neither is a `PositionSource`, so neither can be written
to `sample_point.position_source`, and a tutorial pin still reports
`gps_accuracy_m: null` — zero is not "none", the same defect I fixed in
`manualPinCapture` last wave.

**Why the model data is 18.3 m off plan.** D18 asks for "model data with
deliberate, instructive faults". 18.3 m is past `max_plan_offset_m_warn` (15) and
short of `max_plan_offset_m_block` (30), so the offset chip goes amber and the
deviation picker appears, and the sampler meets that state once here instead of for
the first time in a field. The first simulated fix is a 42 m network-derived
position; it is weighted at about a fortieth of the 4 m fix but is **kept** in
`fix_samples_json`, so the tutorial also demonstrates that nothing is discarded.

**Why `TUTORIAL_SPEC` is a fallback and not the default answer.** A tutorial that
teaches a 10 m accuracy target when the project's spec says 7 has taught the wrong
number and the sampler will not re-learn it. Pass the bundle's real spec when the
device has one. `TUTORIAL_SPEC` exists because a *first-run* tutorial happens
precisely when the device has not synced a bundle yet — and it is the demo project's
own spec from `fixtures/bundle.f26-demo.json`, not a number invented in that file.

**Why `save()` returns a record shaped like the real one.** The closing screen shows
what would have been written. Showing a shape that is not the real shape would teach
the wrong thing about what is recorded — and `would_queue` gives the tutorial the
sentence D18 wants: *five things would be queued; nothing was.*

---

## What I did not do, and why

| # | Thing | Where I stopped |
|---|---|---|
| 1 | **I did not add `tutorial_synthetic` to `CaptureSource`.** | This is the load-bearing decision of the whole wave. Adding it would make a tutorial photograph *representable* in `MEDIA`, on the wire, and in the derivation pipeline — and every compiler barrier above would evaporate at once. If someone later wants tutorial rows persisted (for usage analytics, say), that is a `schema-steward` conversation about a **separate table**, never a fourth enum value. The `@ts-expect-error` in `separation.test.ts` is the alarm on that door. |
| 2 | **I did not give the tutorial a database, even a sandbox one.** | A sandbox SQLite file is a plausible next request ("so the tutorial can show the Outbox screen"). It would trade a compiler guarantee for a runtime convention, and the runtime convention would be "we always point it at the other file". If the tutorial must show an Outbox, feed it `TutorialCaptureResult` — that is what `would_queue` and `media` are for. |
| 3 | **I did not persist `facing_mode` / `track_label` / a capture *mechanism* column.** | Unchanged from wave 2 items 1–2. Still `schema-steward`'s call. |
| 4 | **`EXIF_TS` timezone, `EXIF_POSITION_MISMATCH` threshold, the orphaned `MANUAL_POSITION` rule.** | All unchanged from wave 2. Nothing in this wave touches them. |
| 5 | **No `<input capture>` fallback appeared.** | Wave 2's "guarantees a browser cannot enforce" §1 stands verbatim. The demo problem is now solved without it, which removes the only pressure that ever existed to add one. |
| 6 | **The tutorial photograph carries no EXIF, and I did not fabricate any.** | A drawn image has none, exactly as a `getUserMedia` frame has none. A tutorial that invented a plausible `GPSLatitude` would be teaching the reader of the record that those values can be invented. |

---

## Needs from another agent

Nothing blocking. Three notes, all for `pwa-screens` unless marked:

1. **`structural-guarantee.test.ts`'s `DECLARED_DIRECT_IMPORTERS` entry is now
   stale.** `app/screens/capture/CaptureScreen.tsx` migrated to `CaptureSession` and
   no longer imports `camera/intake.js` — I grepped, there are no direct importers
   outside the capture path at all. **Deleting that one line closes wave-2 request 3.**
   Additions to that list fail the test; removals do not, so closing it can never
   turn the tree red. I did not delete it myself only because the surrounding comment
   is a record of why it existed.
2. **The tutorial banner is not optional.** `state.notice` and
   `state.watermark_text` are on every state emission so a screen cannot forget
   them. Please render `notice` somewhere permanent, not just on the closing card —
   the watermark handles the photograph, but the GPS chip, the barcode field and the
   offset badge in a tutorial run are all model data too.
3. **`src/app/shell/tutorial.ts`'s local-only `tutorial_completed_ts` is the right
   call** given D17's phasing, and it is orthogonal to this lane. No dependency
   either way.

`schema-steward`: item 1 in the table above is the one worth reading — it is a
request *not* to change something, and the reason is in that row.

---

## Files touched

```
 M src/app/capture/save.ts
 M src/app/capture/session.ts
?? src/app/capture/tutorial-boundary.ts
?? src/app/capture/tutorial/index.ts
?? src/app/capture/tutorial/model-data.ts
?? src/app/capture/tutorial/photo-view.ts
?? src/app/capture/tutorial/scripted-gps.ts
?? src/app/capture/tutorial/separation.test.ts
?? src/app/capture/tutorial/session.ts
?? src/app/capture/tutorial/synthetic.ts
?? src/app/capture/tutorial/tutorial.test.ts
?? .claude/fleet/reports/capture-integrity-wave3.md
```

Everything under `src/app/capture/**` plus this report. No screen, component,
shared, e2e or test-directory file was written; `src/app/capture/index.ts`,
`session.test.ts` and `structural-guarantee.test.ts` were not modified. The
browser-verification harness lives in the session scratchpad, outside the repo. **No
git command that writes was run.**
