# capture-integrity — wave 2

**Tasks:** wave-2 capture wiring ("a picture in the flow"), v02 §11 **criterion 11**
(the board's "*is* buildable — `capture-integrity` owns it"), plus the integrity gaps
the screens exposed.

**Gate:** `npm run typecheck` → **clean** · `npm test` → **32 files · 299 passed · 3
failed · 1 skipped (303)**, reported honestly.

- **All 3 failures are `src/app/shell/bundle/apply.test.ts`** — `pwa-screens`' path,
  landed mid-run, failing with `TypeError: Provided value cannot be bound to SQLite
  parameter 2` from its own bundle-apply binds. Nothing to do with capture; wave noise
  per FLEET.md §4.5. An earlier run of the same suite 90 seconds before that file
  appeared was 27 files / 285 passed / 1 skipped, fully green.
- **My files: 21 tests, all passing** — `src/app/capture/session.test.ts` (15) and
  `src/app/capture/structural-guarantee.test.ts` (6). `tests/unit/capture.test.ts`
  (16, untouched, not my path) still passes.

(Note: this ran against a tree `pwa-screens`, `spec-transcriber` and `server-endpoints`
were still writing to. See FLEET.md §4.5 — the authoritative run is
`fleet-integrator`'s.)

---

## The interface `pwa-screens` consumes

**Import from `@app/capture/index.js` and nothing else under `src/app/capture/`.**
The barrel is the door; `camera/intake.js` is not (see "One door", below).

```ts
import {
  createCaptureSession, OpfsMediaBlobStore,
  type CaptureSessionState, type AttachedPhoto, type CaptureAdvisory,
} from '@app/capture/index.js';

// ── construct once per point, at mount ──────────────────────────────────────
const session = createCaptureSession({
  db,                       // SqlDatabase from useDeviceDb()
  spec,                     // ProjectSamplingSpec from the bundle — every threshold
                            // comes from here; none is a constant in the app
  visit_id,                 // string
  visit,                    // FieldVisitPayload | null — upserted at save if given
  plan_point_id,            // string | null  (null = field-added point)
  planned,                  // { lat, lon } | null — advisory offset chip only
  device_id,                // string | null
  sampler_person_id,        // string | null
  blobs: new OpfsMediaBlobStore(),
  // optional, all defaulted: imaging (canvas + exifr + WebCrypto),
  // camera (getUserMedia), geolocation (navigator.geolocation), now, newId, uptimeMs
});

session.sample_uid;                                   // UUIDv7, generated at capture

// ── GPS: on screen open, never at submit ────────────────────────────────────
useEffect(() => { session.start(); return () => { void session.stop(); }; }, []);
const unsubscribe = session.subscribe((s: CaptureSessionState) => setState(s));

// ── camera ──────────────────────────────────────────────────────────────────
await session.openCamera();        // → { ok: true } | { ok: false; reason }
containerRef.current!.appendChild(session.cameraView()!);   // <video>, you style it
session.closeCamera();

// ── photographs ─────────────────────────────────────────────────────────────
await session.capturePhoto('label_photo');   // any MediaRole; opens the camera if needed
await session.addGalleryPhoto('issue_photo', file);  // OptionalMediaRole ONLY —
                                                     // a required role does not compile
await session.removePhoto(mediaId);
// → { ok: true; photo: AttachedPhoto }
// | { ok: false; reason: 'gallery_not_allowed_for_required_role' | 'camera_unavailable'
//                      | 'frame_grab_failed' | 'image_unreadable' | 'blob_write_failed'
//                      | 'already_saved'; detail?: string }

// ── position ────────────────────────────────────────────────────────────────
session.dropPin(lat, lon);          // position_source: 'manual_map_pin', permanently
session.clearPin();
session.setDeviationReason(code);   // drives the offset advisory

// ── save: local only, one transaction, never touches the network ────────────
const result = await session.save({
  conditions: [{ condition_code, condition_value }],
  bags: [{ barcode_raw, barcode_symbology, barcode_capture_method, barcode_scanned_ts,
           lab_id, depth_top_cm, depth_bottom_cm, bag_seq, bag_role,
           void_flag, void_reason_code }],   // barcode stored VERBATIM
  note, depth_achieved_cm, refusal_code, cores_taken, bd_core_taken,
});
// → { sample_uid, media_ids: string[], queued: number, advisories: CaptureAdvisory[] }

await session.discard();            // abandons the point, frees unreferenced bytes
```

`CaptureSessionState`, which is what the screen renders:

```ts
interface CaptureSessionState {
  sample_uid: string;
  gps: GpsState;                    // { fixes, position, accuracyM, spreadM, meetsSpec,
                                    //   acquiring, lastError } — live accuracy chip
  position: GpsCaptureResult | null;      // what would be written right now
  offset_from_plan_m: number | null;      // advisory; the server recomputes it
  camera_status: 'closed' | 'opening' | 'live' | 'unavailable';
  camera_error: CameraUnavailableReason | null;
  photos: AttachedPhoto[];                // media_id, media_role, capture_source,
                                          // content_hash, bytes, w/h, preview_url, …
  missing_required_roles: MediaRole[];    // the three tiles' unsatisfied state
  deviation_reason_code: string | null;
  advisories: CaptureAdvisory[];          // { code, detail } — MISSING_REQUIRED_MEDIA,
                                          // NO_GPS_FIX, GPS_ACCURACY_EXCEEDED,
                                          // MANUAL_POSITION, OFFSET_EXCEEDED_NO_REASON
  saved: boolean;
}
```

Also exported, for screens that want the pieces rather than the session:
`GpsAcquisition`, `manualPinCapture`, `advisoryOffsetFromPlan`, `LiveCameraSource`,
`CameraUnavailableError`, `REQUIRED_ROLES`, `isRequiredRole`, `missingRequiredRoles`,
`browserImaging`, `exifrParser`, `LONG_EDGE_PX`, `JPEG_QUALITY`, `targetSize`,
`OpfsMediaBlobStore`, `MemoryMediaBlobStore`, `mediaLocalPath`, `objectUrlFor`,
`revokeObjectUrl`, `writeCaptureLocally`.

**`advisories` never blocks the save.** Missing data flags, it does not drop (v02 §3).
Whether the Save button is disabled is the screen's decision; the capture path's is
that an imperfect record beats no record.

---

## Landed

| Task | Files | What it does |
|---|---|---|
| Live camera source | `src/app/capture/camera/source.ts` | Owns `getUserMedia` + the `<video>` element. `grab()` checks the track is still `live`, encodes the frame, records track label and reported `facing_mode`. **No file-picker path exists in it.** |
| Real EXIF | `src/app/capture/camera/imaging.ts` | `exifrParser` — full-precision lat/lon, timestamp emitted **without an invented zone**, whole tag set kept as `exif_raw`. `browserImaging()` is the app's `ProcessOptions`. |
| Photo bytes | `src/app/capture/media-blobs.ts` | `MediaBlobStore` + OPFS implementation at `media/<hash>.jpg`, content-addressed, no silent memory fallback. `list()`/`usageBytes()`/`remove()` for the Storage screen. |
| Local write | `src/app/capture/save.ts` | Rows **and** outbox entries in one transaction, correct `depends_on`, `ON CONFLICT DO UPDATE` on named columns so a retry cannot reset `upload_state`/`sync_state`. |
| The session | `src/app/capture/session.ts` | The object above. GPS on open, camera lifecycle, role-typed intake, pin, advisories, save. |
| The door | `src/app/capture/index.ts` | Declared public surface; deliberately does **not** re-export `intakeFromCamera`. |
| Tests | `src/app/capture/session.test.ts`, `structural-guarantee.test.ts` | 21 tests. Real `node:sqlite` + real device migrations + the **demo bundle fixture's** spec. |
| Integrity fix | `src/app/capture/gps.ts` | `manualPinCapture` now reports `gps_accuracy_m: null`, not `0`. See below. |

### How criterion 11 is enforced — four layers, three of them CI-enforced

1. **Type.** `attachRequiredRole` accepts `CameraImage` only; `addGalleryPhoto` takes
   `OptionalMediaRole` only. Asserted by three `@ts-expect-error` directives in
   `session.test.ts` — **verified by physically widening the parameter to `MediaRole`,
   which fails `npm run typecheck` with three `TS2578 Unused '@ts-expect-error'`
   errors.** Weakening the type breaks the build.
2. **Boundary.** The gallery path refuses a required role **before `file.arrayBuffer()`
   is called** — verified by counting reads on a fake `Blob`. Nothing is read, hashed
   or written. Removing that guard fails `session.test.ts` (checked by reverting it).
3. **Minting site.** `capture_source: 'in_app_camera'` is written in exactly one
   function in the entire tree, and `'device_gallery'` in exactly one other.
   `structural-guarantee.test.ts` scans `src/**` and fails on a second site.
4. **Record.** The end-state assertion an auditor would actually make: after driving
   every required role through the gallery path, `SELECT … FROM media` contains **one**
   row — the optional one, marked `device_gallery`, `is_required_role = 0` — and no row
   anywhere carries a required role on non-camera bytes.

### `manualPinCapture` reported a zero accuracy

Prior-wave defect in my own file: a dropped pin wrote `gps_accuracy_m: 0`. Zero is not
"none" — it reads as a *perfect measurement* to anyone querying `SAMPLE_POINT` in 2029,
and the value would have passed any `accuracy <= threshold` filter. Now `null`.
`GpsCaptureResult.gps_accuracy_m` is `number | null`; no consumer outside this lane was
affected. `noGpsFixRule` was never fooled (it branches on `position_source` first),
which is exactly why that column exists.

---

## Guarantees a browser cannot enforce — say it here rather than degrade quietly

**1 · `<input capture="environment">` is not a camera, and the record cannot tell.**
On Android Chrome it opens the OS camera app. On desktop Chrome and Firefox the
attribute is **ignored** and the user gets a file picker — so a photograph off a hard
disk arrives through the path we would be calling "in-app camera", and `CaptureSource`
has no third value meaning "we asked for a camera and got a file browser".
**Decision: the required-role path uses `getUserMedia` only.** There is no `<input
capture>` fallback anywhere in `src/app/capture/`. No camera → `capturePhoto` returns
`{ ok: false, reason: 'camera_unavailable' }`, the role stays visibly unsatisfied, and
nothing is written. The demo costs a camera permission prompt; it does not cost the
guarantee.

**2 · A `getUserMedia` frame carries no EXIF.** The pixels never pass through the OS
camera app's JPEG encoder, so a required-role photograph has no `DateTimeOriginal` and
no `GPSLatitude` — `exif_gps_present` is honestly `false` and `EXIF_POSITION_MISMATCH`
has nothing to compare on required roles. **Nothing is destroyed; there was never
anything there.** This is the real cost of choosing provenance over corroboration, and
it is worth naming to whoever wrote §9 expecting both. It returns in the 2027 Capacitor
build: a native camera plugin returns a real JPEG *with* EXIF and still cannot be a
file picker — it implements `CameraSource` and nothing above that file changes.

**3 · A desktop webcam is not a rear camera.** `facingMode: { ideal: 'environment' }`
is a request, not a constraint (`exact` throws on front-camera-only devices). What the
track actually reports is captured in `CameraFrame.facing_mode` — and **there is
nowhere in `MEDIA` to persist it.** See "Stopped".

**4 · TypeScript has no package-private.** Layer 3 above is a CI-enforced import
boundary, not a compiler error, because `camera/intake.ts` must keep exporting
`intakeFromCamera(bytes, …)` for `tests/unit/capture.test.ts` — a file outside my
declared paths (FLEET.md §4 rule 2). Making it a compiler error is a two-line change
the orchestrator can make: change the parameter to `CameraFrame` and update that test's
three call sites to pass `{ provenance: 'live_camera_stream', bytes, … }`. I did not do
it, and the tripwire test is what stands in until someone does.

**5 · No test here claims v02 §11 criteria 6 or 7.** The camera in the tests is a
double standing in for a `MediaStream`. Ninety seconds in a field and a ten-hour battery
day are scheduled, not simulated.

---

## Stopped, and why

| # | Unspecified | Where I stopped |
|---|---|---|
| 1 | **Nowhere to record the capture *mechanism*.** `MEDIA.CAPTURE_SOURCE` has three values; `getUserMedia`, an OS camera app via `<input capture>`, and a native Capacitor camera are all `in_app_camera`, and a desktop file picker masquerading as the second is indistinguishable from the first. I did **not** add a column or overload an existing one. If the `<input capture>` path is ever wanted (it is the only way to get EXIF on required roles in a PWA), it needs a `CAPTURE_MECHANISM` column first — `schema-steward`'s call. |
| 2 | **`facing_mode` and `track_label` have no home in `MEDIA`.** Both are captured in `CameraFrame` and shown to the screen; neither is persisted, because inventing a column is worse than losing a nice-to-have. Same request as #1 if it is wanted. |
| 3 | **`EXIF_TS` is `TIMESTAMP_NTZ` in Snowflake and `timestamptz` in Postgres.** EXIF `DateTimeOriginal` has no zone. `NTZ` is right; `timestamptz` will attach the session zone at insert and silently reconcile a value v02 §9 says must be preserved verbatim. I emit `2026-10-02T15:00:00` with no designator and left the DDL alone — `schema-steward`. |
| 4 | **`EXIF_POSITION_MISMATCH` threshold** — still unnamed in v02 §9 (already on the board as item 3). Unchanged: the capture path preserves both positions and compares neither. |
| 5 | **A dropped pin discards the fixes the receiver had at the time.** `manualPinCapture` writes `fix_count: 0` and `fix_samples_json: []` by design (B6), so if the receiver *was* producing fixes when the sampler chose to place a pin, that evidence is not kept. Keeping it would need a place to put it that does not read as the sample's own fix. Named, not invented. |
| 6 | **`device_uptime_ms` is `performance.now()`** — milliseconds since the app instance started, because the web has no device uptime. It still exposes a clock moved *during* a session; across sessions the bundle's `server_time` delta is the baseline. Flagging it because `CLOCK_DRIFT_SUSPECTED` will be written against this column and its meaning is narrower than its name. |
| 7 | **No `local_defect` rows are raised from capture.** `MISSING_REQUIRED_MEDIA`, `NO_GPS_FIX`, `GPS_ACCURACY_EXCEEDED` and `MANUAL_POSITION` are all derivable server-side from the row itself; a device-raised duplicate would mean two defect rows for one fact. They surface as `advisories` in the UI instead. **`MANUAL_POSITION` therefore remains orphaned** (board item), and I deliberately did not close it from this side — it belongs to `defect-rules`. |

---

## Needs from another agent

Appended in full to `integration/requests-b.md`. Two are integrity defects, not style:

1. **`src/app/shell/media/exif.ts` shifts every EXIF timestamp by the device's timezone
   offset.** `exifr` revives zoneless `DateTimeOriginal` as a local `Date`;
   `.toISOString()` then rewrites it in UTC. A phone in US/Central stores
   `2026-10-02T20:00:00.000Z` for a 15:00 photograph and the original is unrecoverable
   from the value. Fix: delete it, import `exifrParser` from `@app/capture/index.js`.
2. **`getPhotoStore()` silently falls back to in-memory.** Until upload these bytes are
   the only copy of the evidence; a reload loses a day's photographs while the `media`
   rows survive pointing at nothing.
3. **Migrate `CameraTile`/`handleCapturePhoto` onto `CaptureSession`.**
   `onCapture(bytes: Uint8Array)` is a bytes-typed prop, so provenance is a convention
   held by one component. Their `handleSave` also writes rows and enqueues **outside a
   transaction** — a force-quit between them leaves a sample that never syncs and never
   appears in the Outbox screen (v02 §11 criterion 2). `session.save()` is one
   transaction.
4. **`fix_count ?? 0`, `fix_spread_m ?? 0`** in `handleSave` — same "zero is not none"
   defect I just fixed in `manualPinCapture`.

`structural-guarantee.test.ts` carries `app/screens/capture/CaptureScreen.tsx` in
`DECLARED_DIRECT_IMPORTERS`, dated and explained. Deleting that one line is how request
3 closes; **additions to that list fail the test, removals do not**, so closing the gap
can never be the thing that turns the tree red.

`schema-steward`: items 1–3 in "Stopped".

---

## Files touched

```
 M integration/requests-b.md
 M src/app/capture/gps.ts
?? src/app/capture/camera/imaging.ts
?? src/app/capture/camera/source.ts
?? src/app/capture/index.ts
?? src/app/capture/media-blobs.ts
?? src/app/capture/save.ts
?? src/app/capture/session.ts
?? src/app/capture/session.test.ts
?? src/app/capture/structural-guarantee.test.ts
?? .claude/fleet/reports/capture-integrity-wave2.md
```

Everything under `src/app/capture/**` plus the two append-only shared files. No screen,
component, shared or test-directory file was written. No git command that writes was
run.
