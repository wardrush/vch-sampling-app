# pwa-screens — wave 3

**Tasks:** Task 1 (fix the device DB so it opens on the main thread with a
memory fallback), Task 2 (a real-browser Playwright smoke test), Task 3
(B14 — the sampler tutorial branch, v02 D18), plus a coordinator follow-up
mid-wave: the Field screen's map was rendering as a blank flat colour on a
real Pixel 7 viewport, invisible to the original e2e suite.

**Gate:**
- `npm run typecheck && npm test` → **pass** — 33 test files, **333 passed, 1
  intentionally skipped** (334 total).
- `npm run build` → **pass**.
- `npm run test:e2e` → **pass, both projects** (`chromium`, `android-viewport`).
  Run clean **four separate times** across this wave, including twice against
  a genuinely fresh build immediately after the map fix (the first "pass" on
  the map fix was a false positive from a stale `vite preview` server on port
  4173 left over from an earlier run — caught by re-running against a
  deliberately-reverted `FocusShell.tsx`, which correctly turned the suite
  red, then re-confirmed green after killing the stale server and rebuilding
  for real. See "The map collapse" below.).

All ran clean, back to back, at the end of this session — not just once
mid-work. (Note per FLEET.md §4.5: this still ran against a tree
`capture-integrity` was concurrently writing to for part of the wave; see
"Files touched" for what is genuinely mine.)

## Landed

| Task | Files | What it does |
|---|---|---|
| 1 | `src/app/shell/db/wa-sqlite-opfs.ts` | Root cause fixed **and** a second, worse bug found and fixed underneath it (see below). Registers `IDBBatchAtomicVFS` (IndexedDB-backed, main-thread, `grep -c createSyncAccessHandle` → `0`) as the primary VFS; falls back to `MemoryAsyncVFS` only if that fails; every `SqlDatabase` call is now serialized through an internal FIFO queue (`WaSqliteDatabase.schedule()`) — this is the part that was *not* in the original brief and turned out to be load-bearing (see "Stopped, and why" — no, see the paragraph below, this one I did *not* stop on). `openWaSqliteOpfsDatabase()`'s signature and `SqlDatabase` are unchanged; `WaSqliteDatabase.backend: 'idb' \| 'memory'` is additive. |
| 1 | `src/app/shell/db/wa-sqlite-examples.d.ts` | Ambient types for `IDBBatchAtomicVFS.js` (not shipped by `wa-sqlite`'s own `.d.ts`), replacing the now-unused `OriginPrivateFileSystemVFS` stub. |
| 1 | `src/app/shell/db/device-db.ts` | `DeviceDbHandle` gains `backend: WaSqliteBackend \| 'unknown'`, read off the concrete driver object via a runtime duck-type check (`backendOf()`) — `SqlDatabase` itself (`exec`/`run`/`all`) is untouched, per the brief. |
| 1 | `src/app/shell/db/DeviceDbProvider.tsx` | `DeviceDbState`'s `'ready'` variant carries `backend` through to every screen via `useDeviceDb()`. |
| 1 | `src/app/shell/MemoryFallbackBanner.tsx` (new) | The honest, non-dismissible indicator: renders only when `backend === 'memory'`, wired into both `AppShell` and `FocusShell` so it is visible on every screen including Capture. |
| 1 | `src/app/shell/db/device-db.test.ts`, `wa-sqlite-opfs.browser.test.ts` | Updated for the new failure message and the IndexedDB (not OPFS) feature-detect; added a case proving an untagged connection (the Node-SQLite test fake) reports `backend: 'unknown'` rather than a guess. |
| 2 | `tests/e2e/sampler-flow.spec.ts` (new) | Drives Today → Field → Capture → save → Field → Today → Outbox → reload, in real Chromium (desktop + Pixel 7 viewport), against the production bundle. Asserts the "Device database unavailable" banner is *never* present, asserts `MemoryFallbackBanner`'s text is *also* never present (proves the primary IndexedDB path — not the fallback — is what answered), asserts every console error and every HTTP ≥400 response, with exactly two named, justified exceptions (see the file). |
| 3 | `src/app/shell/tutorial.ts` (new) | `getTutorialCompletedTs()` / `markTutorialCompleted()`. Local `localStorage` write is the source of truth; a best-effort `POST /v1/device/tutorial-complete` is attempted and silently ignored on failure — **that endpoint does not exist**, see "Stopped, and why". |
| 3 | `src/app/shell/routes.ts` | Added `ROUTE_PATHS.tutorial = '/tutorial'`. |
| 3 | `src/app/App.tsx` | Wired `TutorialScreen` under `FocusShell` (additive diff only — see below, nothing of spec-transcriber's wave-2 wiring was touched). |
| 3 | `src/app/screens/today/TodayScreen.tsx` | First-run redirect (`useEffect` on mount, `navigate(ROUTE_PATHS.tutorial, {replace:true})` iff `getTutorialCompletedTs()` is null) and a permanent "Show me again ↺" link in the status strip (v02 §4.5: "a small permanent 'show me again' link, and nothing else"). |
| 3 | `src/app/screens/tutorial/TutorialScreen.tsx`, `TutorialCaptureStep.tsx` (new) | The four-step walkthrough. See design notes below. |
| follow-up | `src/app/shell/FocusShell.tsx` | `height: '100%'` in place of `minHeight: '100%'` on the shell root, plus `minHeight: 0` on `main` — the actual layout fix. See "The map collapse" below. |
| follow-up | `tests/e2e/sampler-flow.spec.ts`, `tests/e2e/support/png.ts` (new) | Field-screen assertions: map container height, viewport-fill ratio, zero dead-space gap to the point-chip strip, and a real screenshot pixel sample (via a small hand-rolled PNG decoder — `node:zlib` only, no new dependency) proving the boundary polygon is actually painted, not just a correctly-sized empty canvas. |

## The bug under the bug — what actually made Task 1 pass

The brief's diagnosis (`createSyncAccessHandle` on the main thread) was
correct and the `IDBBatchAtomicVFS` swap fixed it — the app opened on first
load. But the very next reload of a database that actually had data in it
(i.e. every real second app-open, not an edge case) hard-failed again with
the **identical** banner text, `unable to open database file`, for a
**different** reason. I did not stop at "the brief's fix works," because
that message reappearing at all was reason enough to keep going.

Root cause, found by instrumenting every `exec`/`run`/`all` call and
reproducing against the built production bundle in real Chromium (not
simulated): this is the Asyncify (async) wasm build, and a single low-level
call unwinds/rewinds one wasm coroutine across however many awaited
IndexedDB operations it needs — that mechanism assumes exactly one call is
ever in flight on a connection at a time. `SqlDatabase.exec/run/all` never
promised callers that, and the app has several call sites that read as
ordinary parallel queries — `Promise.all([listBoundarySummaries(db), new
OutboxStore(db).counts()])` in `TodayScreen`, five queries at once in
`CaptureScreen`'s load effect. Two such calls racing on the same connection
reliably corrupted `IDBBatchAtomicVFS`'s internal state once the database
held enough real data that either query needed more than a single-page
read — reproduced 100% of the time, every reload, right up until I added
`WaSqliteDatabase.schedule()`, an internal FIFO queue that serializes every
call. After that: five back-to-back reloads, zero failures; the e2e suite
(which does a real reload mid-flow specifically to catch this) is green
twice in a row.

I considered and rejected auditing/serializing every `Promise.all` call site
across the app instead — that's `TodayScreen`, `CaptureScreen`, and every
future screen anyone writes, forever, versus one queue in the one file that
"knows wa-sqlite exists." Full reasoning is in that file's header comment,
including exactly what the crash looked like (`memory access out of
bounds`, `Cannot read properties of undefined (reading 'data')`) so the next
person who sees those doesn't have to re-derive it.

I looked hard for a simpler explanation before landing on this one —
specifically, `PRAGMA journal_mode = WAL` in `bootstrapDeviceDb`
(`src/shared/db/schema.ts`, `schema-steward`'s, not mine) is a real
mismatch with `IDBBatchAtomicVFS` (no `xShmMap`) and I tried rewriting it to
`MEMORY` at the driver layer first. It did not fix the reload; the
concurrency queue did, on its own, with the WAL pragma left completely
alone. I want to flag the WAL mismatch anyway even though it turned out not
to be *this* bug — see "Stopped, and why."

## The map collapse — coordinator follow-up

**Diagnosis.** The coordinator's own DOM probe was exactly right and I did
not need to re-derive it: `.maplibregl-map` (the div MapLibre creates inside
whatever container `<BoundaryMap>` — `src/shared/map/BoundaryMap.tsx`,
`map-surface`'s, unread except to confirm this — hands it) resolved to
`clientHeight: 0` while its canvas kept the size MapLibre had last measured.
That div is styled `width/height: '100%'`. CSS percentage heights only
resolve against a containing block with an *explicit* height; a containing
block whose height comes from `min-height` on an otherwise auto-sized box is
not that. `FocusShell.tsx` (mine) was the one broken link: its root used
`minHeight: '100%'` — copied, it looks like, from `AppShell`, where it is
correct (Today/Outbox/Storage scroll at the page level and have no
percentage-height descendant) — instead of `height: '100%'`, which is what
`CaptureScreen`/`SkipScreen`/`FieldScreen` already assumed further down the
same chain (`CaptureScreen`/`SkipScreen` each already carry their own
internal `flex: 1; overflowY: 'auto'` content region, which only makes sense
against a fixed-height ancestor). The collapse was genuinely upstream of
`<BoundaryMap>`, in my own paths, exactly as the coordinator suspected —
I did not need to route this to `map-surface`.

**Fix:** `src/app/shell/FocusShell.tsx` — `minHeight: '100%'` → `height:
'100%'` on the shell root, plus `minHeight: 0` on `main` (the standard fix
for a flex item's default auto min-height otherwise resisting shrinking
below its content, which is what lets `CaptureScreen`/`SkipScreen`'s own
inner scroll regions scroll instead of blowing out the shell). Full
reasoning is in that file's header comment now. Verified visually
(screenshotted the fixed build at a Pixel 7 viewport: boundary polygon and
all six pins render; map container height 693px of a ~915px CSS viewport)
before touching the test.

**The 404.** Tracked with `page.on('response')` (URL-bearing, unlike the
`console` "Failed to load resource" line, which is what the coordinator's
own console output — and mine, earlier in this wave — actually saw). At no
point in the Today → Field flow does anything request `tiles.example.com`
— confirmed directly: `FieldScreen` always passes `tilePackUrl={null}` (its
own header already says why: no PMTiles route-pack builder exists yet, "not
a bug"), so `<BoundaryMap>` never constructs a tile URL. The **only** 404 in
the whole flow through Field is `/v1/device/tutorial-complete` — my own
best-effort, already-documented, already-expected gap (see "Stopped, and
why" #1). The coordinator's "likely the tile pack" was a reasonable guess
that turned out not to be it; nothing else is missing.

**Dead space.** Resolved by the same `height: '100%'` fix, not a separate
change: the coordinator's screenshot showed the point-chip strip floating
over empty page beneath it, which was the `minHeight: 240` *floor* on
`FieldScreen`'s map wrapper asserting itself (content-sized layout, nothing
telling it to actually fill the viewport) rather than `flex: 1` genuinely
expanding to fill available height. With a resolved ancestor chain, the map
wrapper's `flex: 1` now fills all remaining space and the strip sits flush
beneath it — confirmed both visually and by the new "gap below map < 40px"
assertion. The flat colour still visible above/below the boundary polygon
*inside* the map itself is expected `fitBounds` behaviour for a boundary
whose aspect ratio does not match a portrait phone viewport (real satellite
imagery, once a PMTiles route-pack builder exists, would fill that same
area) — not dead space, and `FieldScreen`'s own header already calls this
out as "not a bug" for the missing-basemap case.

**A false-positive lesson worth recording.** My first "fix confirmed, e2e
green" run was wrong — not because the fix was wrong, but because
`playwright.config.ts`'s `webServer.reuseExistingServer: !process.env.CI`
reused a `vite preview` process left running on port 4173 from an earlier
`npm run test:e2e` invocation in this same session, so the "fixed" run
never actually rebuilt against my `FocusShell.tsx` edit. I caught this only
because I deliberately reverted the fix and expected the suite to go red —
it stayed green, which was the tell. Killed the stale server, reran, got
the correct red, restored the fix, reran, got the correct green, and ran it
a second time after that for stability. Recorded here because the same trap
is available to anyone iterating locally with `npm run test:e2e` across
multiple invocations in one session — a stray `vite preview` from a
previous run silently wins over a fresh build unless port 4173 is empty
first.

## Design notes on the tutorial (Task 3)

- **Today/Field steps are read-only against `demoBundleFromFixture()`**
  (`@app/shell/bundle/client.js`) — the same six-point, one-boundary F0.7
  fixture v02 §4.5 names as this app's model dataset, and the same one that
  already answers `fetchAssignmentBundle()` whenever no assignments server
  is reachable. The tutorial screen never calls `applyBundleToDevice` — it
  reads the fixture and renders it directly, so these two steps make **zero
  device-database writes**, which is a stronger guarantee than "discarded."
- **The Capture step drives `capture-integrity`'s real
  `TutorialCaptureSession`** (`@app/capture/tutorial/index.js`) rather than
  a screen-only mockup — real GPS averaging over a scripted receiver, real
  downscale/hash pipeline over a drawn (watermarked) frame, real
  `save()` returning the record a save *would* have produced. I found this
  module mid-build by another concurrent agent and read it in full before
  depending on it; it is a declared, stable "second door"
  (`src/app/capture/tutorial/index.ts`'s own header: "Screens import from
  `@app/capture/tutorial/index.js` and nothing else under
  `src/app/capture/tutorial/`") built specifically for this integration, so
  I used it rather than re-inventing a synthetic capture path.
- Today/Field's model data (the ambient demo fixture) and Capture's model
  data (`TUTORIAL_PLAN_POINT`, a separate reserved-namespace example point)
  are deliberately **not** reconciled into one continuous story — the two
  steps teach different things ("here's what your real assignments look
  like" vs. "here's what happens when you tap a point") and forcing them to
  share one fictional boundary would have meant either writing to the real
  device DB from the tutorial or inventing a third data source. Said so
  explicitly in the tutorial screen's own header.
- Skip and Finish both call `markTutorialCompleted()` identically (v02 §4.5:
  "An adult who skips a tutorial has made a decision").

## Contract or interface changes others need

```ts
// src/app/shell/db/wa-sqlite-opfs.ts — additive
export type WaSqliteBackend = 'idb' | 'memory';
// WaSqliteDatabase now has a public readonly `backend: WaSqliteBackend`
// field, extra to the SqlDatabase interface it implements.

// src/app/shell/db/device-db.ts — additive
export interface DeviceDbHandle {
  db: SqlDatabase;
  migration: MigrateResult;
  backend: WaSqliteBackend | 'unknown'; // new field
}

// src/app/shell/db/DeviceDbProvider.tsx — additive
// the 'ready' variant of DeviceDbState now also carries `backend`.

// src/app/shell/routes.ts — additive
ROUTE_PATHS.tutorial = '/tutorial';
```

`SqlDatabase` itself (`src/shared/db/types.ts`, `schema-steward`'s) is
byte-for-byte unchanged.

## Stopped, and why

1. **`v02 §4.5`'s server-side `tutorial_completed_ts` does not exist.**
   `netlify.toml` declares no route, there is no function file, and D17's
   phased auth means there's no durable per-device identity to hang a
   server-side flag on yet regardless. I did not invent an endpoint path a
   server would actually implement — `src/app/shell/tutorial.ts` attempts
   `POST /v1/device/tutorial-complete` best-effort, always 404s today, and
   says so in its own header rather than pretending the gap is closed. Local
   `localStorage` persistence is the fallback the task instructions asked
   for explicitly. Whoever builds the real endpoint should also decide what
   identity it's keyed on — that's a D17 question, not mine to answer.
2. **`PRAGMA journal_mode = WAL` in `bootstrapDeviceDb`
   (`src/shared/db/schema.ts`) requests a mode `IDBBatchAtomicVFS` cannot
   provide** (no `xShmMap` implemented on that VFS at all). It appears to
   silently no-op today rather than error — the app works correctly without
   me touching it, and I did touch it briefly during the investigation above
   and reverted that change once the real cause (concurrency, not WAL) was
   found. I'm naming it rather than "fixing" it because `schema.ts` is
   `schema-steward`'s file, not mine, and because I only confirmed the
   *symptom* (a harmless no-op) not the *guarantee* — a future SQLite/wa-sqlite
   upgrade could change that silent-fallback behavior, and whoever owns that
   file should decide whether `journal_mode` ought to be backend-aware at
   all, which is a schema/portability decision, not a driver-adapter one.
3. **The chunk-size warning at build** (`index-*.js` at ~1.6 MB) is
   pre-existing (present before this wave too) and out of scope — `vite dev`/`build`
   config is orchestrator-owned.
4. **Real-hardware criteria (v02 §11 items 6/7) are not simulated here**,
   per the non-negotiables — the e2e suite proves the database opens and
   persists in a real browser; it makes no timing or battery claim.

## Needs from another agent

None that require a code change in someone else's paths — the WAL-pragma
note above is informational (item 2 in "Stopped, and why"), not a request,
since the current behavior is correct and I have no replacement value to
suggest without knowing whether `schema-steward` wants the schema layer to
stay backend-agnostic (my preference) or wants an explicit non-WAL default
written into the schema itself.

## How to see it, on a deployed URL, without reading code

1. Open the deployed URL cold (private/incognito is fine — it's still one
   IndexedDB-backed database per browser profile). You land on **Quick
   walkthrough** automatically.
2. Step through **Today → Field → Capture → Outbox** with Next, or tap
   **Skip** at any point — both paths end the same way, back on the real
   Today screen.
3. On the Capture step, tap the three photo tiles (Label/Core/Site) — each
   draws a watermarked placeholder image in under a second, no camera
   permission prompt. Tap **Save**. It reports what would have queued in the
   Outbox and confirms zero rows were actually written.
4. Back on the real **Today**, tap **Johnson Farm - East 40** → **Field**
   shows the six real demo points on the map → tap any pin → **Capture**
   (the real screen this time) → **Save** with no camera/GPS granted at all
   (both are advisory, not required) → you land back on Field with "1 of 6
   points done."
5. Tap **Outbox** in the bottom nav: pending count, pending photo MB, a
   "Sync now" button, and the record you just saved, all present. Reload the
   page — it's all still there.
6. From Today, **"Show me again ↺"** re-opens the walkthrough any time.

## Files touched

Taken at the very end of the wave, after the map-collapse follow-up landed
(`capture-integrity`'s wave-3 files no longer show as a diff here — that
agent's work finished and was folded into the base tree earlier in the
session; nothing below is theirs anymore):

```
 M src/app/App.tsx
 M src/app/screens/today/TodayScreen.tsx
 M src/app/shell/AppShell.tsx
 M src/app/shell/FocusShell.tsx                    ← map-collapse fix
 M src/app/shell/db/DeviceDbProvider.tsx
 M src/app/shell/db/device-db.test.ts
 M src/app/shell/db/device-db.ts
 M src/app/shell/db/wa-sqlite-examples.d.ts
 M src/app/shell/db/wa-sqlite-opfs.browser.test.ts
 M src/app/shell/db/wa-sqlite-opfs.ts
 M src/app/shell/routes.ts
?? .claude/fleet/reports/pwa-screens-wave3.md
?? src/app/screens/tutorial/                       (TutorialScreen.tsx, TutorialCaptureStep.tsx)
?? src/app/shell/MemoryFallbackBanner.tsx
?? src/app/shell/tutorial.ts
?? tests/e2e/                                       (sampler-flow.spec.ts, support/png.ts)
```

`src/app/capture/**` (`capture-integrity`'s `TutorialCaptureSession` and its
supporting modules) is real, landed, and imported from
(`TutorialCaptureStep.tsx`) — it simply is not in this diff because it was
already part of the tree by the time this report was finalised, not because
it went away.
