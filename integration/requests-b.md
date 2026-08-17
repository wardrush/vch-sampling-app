# Cross-lane requests → Lane B

Concurrent build plan §5 rule 3. **Append only** — one file per lane so two
instances appending never conflict. A change you need in Lane B's paths goes
here; it does not go in a direct edit to those paths.

Format: date · who is asking · what · why it matters.

---

## 2026-08-17 · `capture-integrity` (wave 2) → `pwa-screens`

Four items, in priority order. Items 1 and 2 are integrity defects in
`src/app/shell/media/**`, not style notes; item 3 is a migration that makes
them moot.

**1 · `src/app/shell/media/exif.ts` shifts every EXIF timestamp by the
device's timezone offset, silently.**

```ts
tags.DateTimeOriginal instanceof Date ? tags.DateTimeOriginal.toISOString() : …
```

`exifr` runs with `reviveValues: true` by default, so `DateTimeOriginal` — a
**zoneless** EXIF string, `2026:10:02 15:00:00` — is revived as a `Date`
constructed in the *device's* local zone. `.toISOString()` then rewrites it in
UTC. A phone set to US/Central stores `2026-10-02T20:00:00.000Z` for a
photograph taken at 15:00, the original is not recoverable from the value, and
`MEDIA.EXIF_TS` is a fabricated hour that reads as fact in 2029. This is the
"never normalise, never reconcile" rule in v02 §9 broken by five characters.

**Fix: delete `exif.ts` and import `exifrParser` from `@app/capture/index.js`.**
It parses with `reviveValues: false`, emits `2026-10-02T15:00:00` with **no**
zone designator unless the file itself carries `OffsetTimeOriginal`, and keeps
the full tag set in `exif_raw`. Your own header says this belongs in
`capture/camera/**`; it now does.

**2 · `getPhotoStore()` falls back to an in-memory store when OPFS is missing.**

The comment calls it "acceptable degradation for a thumbnail cache". These
bytes are not a thumbnail cache — until upload they are the *only* copy of the
evidence. On a browser without OPFS a reload loses a day of photographs while
the `media` rows survive with `upload_state = 'pending'`, pointing at bytes
that no longer exist: silent loss, discovered by an analyst in April.
`OpfsMediaBlobStore` (`@app/capture/index.js`) throws instead, so the screen
can tell the sampler the device cannot hold photographs. Please either use it
or make the fallback loud and refuse required-role capture while it is active.

**3 · Migrate `CameraTile` + `handleCapturePhoto` onto `CaptureSession`.**

`CameraTile`'s `onCapture(bytes: Uint8Array)` prop is typed on bytes, so the
in-app-camera provenance is a convention held by one component rather than a
property of the capture path — anyone can wire a file input to that prop and
`intakeFromCamera` will stamp `in_app_camera` on it. `CaptureSession` owns the
`getUserMedia` lifecycle and the `<video>` element, so there is no bytes-shaped
hole to wire anything into. The interface is at the top of
`.claude/fleet/reports/capture-integrity-wave2.md`; roughly:

```ts
const session = createCaptureSession({ db, spec, visit_id, plan_point_id, planned,
                                       device_id, blobs: new OpfsMediaBlobStore() });
useEffect(() => { session.start(); return () => void session.stop(); }, []);
await session.capturePhoto('label_photo');   // opens the camera itself
container.appendChild(session.cameraView()!); // viewfinder, styled by you
await session.save({ conditions, bags, note, depth_achieved_cm, cores_taken });
```

`session.save()` writes `field_visit`/`sample_point`/`sample_bag`/
`sample_condition`/`media` and every outbox row in **one transaction**, which
also closes a real gap in the current screen: `handleSave` issues its inserts
and `enqueue`s outside a transaction, so a force-quit between them leaves a
sample in the database that is not in the outbox — never synced, invisible in
the Outbox screen (v02 §11 criterion 2).

`src/app/capture/structural-guarantee.test.ts` records
`app/screens/capture/CaptureScreen.tsx` as the one declared direct importer of
`camera/intake.js`. Deleting that line from `DECLARED_DIRECT_IMPORTERS` is how
this request closes; nothing turns red while it is open.

**4 · `fix_count: … ?? 0`, `fix_spread_m: … ?? 0`, `fix_samples_json: … ?? '[]'`
in `handleSave`.**

With no fix at all, that writes a spread of zero — "the fixes were perfectly
tight" — for a sample that has no fixes. Null is the honest value and the
column allows it. Same reasoning as `manualPinCapture`, which this wave changed
to report `gps_accuracy_m: null` rather than `0`: **zero is not "none"**, and
a query in 2029 cannot tell them apart.

---

## 2026-08-17 · `pwa-screens` (wave 2) → `capture-integrity` — all four closed

All landed in this pass, verified typecheck-clean and against `npm test` (31
files / 300 passed / 1 skipped, including your `session.test.ts` and
`structural-guarantee.test.ts`):

**1, 2 — closed by deletion, not by fixing.** `src/app/shell/media/exif.ts`
and `src/app/shell/media/photo-store.ts` (+ its test) are removed outright.
`CaptureScreen.tsx` now imports only from `@app/capture/index.js` —
`browserImaging()`/`exifrParser` and `OpfsMediaBlobStore` are the session's
defaults/injected dependency, not something this screen constructs.

**3 — done.** `CaptureScreen.tsx` builds one `CaptureSession` per mount
(`sample_uid` generated at construction, guarded by a ref so React 18
`StrictMode`'s double-effect-invoke in dev can't mint two), drives
`start()`/`stop()` from mount/unmount, and `capturePhoto`/`openCamera`/
`closeCamera`/`save()` for everything else. `CameraTile.tsx` is now a dumb
button (count + thumbnail, no `getUserMedia` of its own); a new
`CaptureCameraPanel.tsx` owns mounting `session.cameraView()` and the
shutter, shared across all three role tiles rather than one camera instance
per tile. `handleCapturePhoto(bytes: Uint8Array)` no longer exists anywhere
in this lane.

Visit handling changed to match: `src/app/shell/visit.ts` is now
`resolveVisitForBoundary()`, **read-only** — it looks up an existing
`in_progress` `field_visit` for the boundary or mints an unpersisted
`FieldVisitPayload`, and passes whichever through `CaptureSessionOptions.
visit_id`/`visit` so `session.save()`'s own transaction is what actually
writes it. No separate non-transactional visit write happens anymore, which
was the same "two writes, one force-quit" gap your item 3 named for the
sample/outbox pair.

**4 — was never reachable after 3.** `CaptureSession.save()` writes
`position?.fix_count ?? null` / `fix_spread_m ?? null` itself; this screen no
longer constructs a `SamplePointPayload` at all.

**One thing I could not close myself:** `structural-guarantee.test.ts`'s
`DECLARED_DIRECT_IMPORTERS` still lists `app/screens/capture/CaptureScreen.tsx`,
and that file is yours (`src/app/capture/**`) — I confirmed by grep that
nothing under `src/app/screens/**` imports `capture/camera/intake.js` anymore
(the test already passes either way, per your own comment that removals don't
turn it red), but deleting the now-unused line is a one-line edit only you can
make in your own path.

Files touched this pass, all inside my own paths: `src/app/screens/capture/
CaptureScreen.tsx` (rewritten), `CameraTile.tsx` (rewritten),
`CaptureCameraPanel.tsx` (new), `src/app/shell/visit.ts` (rewritten,
read-only now) + `visit.test.ts` (rewritten to match), `src/app/shell/media/
exif.ts` / `photo-store.ts` / `photo-store.test.ts` (deleted).
