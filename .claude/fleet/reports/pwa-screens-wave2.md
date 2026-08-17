# pwa-screens — wave 2

**Tasks:** B4 (Screen 1 · Today), B5 (Screen 2 · Field), B7 (barcode capture +
the Capture screen shell/wiring), B11 (Screen 5 · Outbox). Goal per the
orchestrator's brief: a demonstrable **Today → Field → Capture (with a real
photo) → Outbox** flow, not six polished screens.

**Gate:** `npm run typecheck && npm test` → **pass.** `tsc --noEmit`: 0
errors. `vitest run`: **31 test files, 300 passed, 1 skipped (301 total)**.
`npm run build` succeeds (342 modules, `dist/sw.js` generated, 25 precache
entries / ~3.0 MB). `npm run dev` (`vite`, `MOCK_SNOWFLAKE=1`) serves every
route at HTTP 200 and every module I touched transforms cleanly through
Vite's pipeline (curled directly, not just loaded through the SPA shell) —
no build-time error surfaced in the dev-server log across three separate
runs, the last one after every edit in this report.

(This ran against a tree three other agents — `capture-integrity`,
`spec-transcriber`, `server-endpoints` — were concurrently writing to in the
same wave. Per FLEET.md §4.5 this is not authoritative; `fleet-integrator`'s
run is. I re-ran the full gate after each of their landings touched a file I
import from, specifically after `capture-integrity`'s `@app/capture/index.js`
appeared, and rewrote against it rather than leaving two competing capture
implementations in the tree — see "A mid-wave course correction" below.)

---

## The reproducible demo walkthrough

**Setup:** `MOCK_SNOWFLAKE=1 npm run dev`, open the served URL in a real
browser (a phone, or a laptop with a webcam — the camera step is real
`getUserMedia`, not stubbed, and needs actual camera hardware to complete).

1. **Today** (`/`). On first load, the screen has no downloaded assignments
   yet, so it fetches the bundle itself: tries `GET /v1/assignments/bundle`
   (nothing answers under plain `vite dev` — see "The one real gap" below),
   falls back to the F0.7 demo fixture reshaped client-side, and applies it
   to the device SQLite database. One boundary card appears: **Johnson Farm
   — East 40**, 40.5 ac, a progress ring at 0%, a tap-to-call link for John
   Johnson (605-555-0101), and status badges for the outbox (0 pending) and
   assignment expiry. Tap the card.
2. **Field** (`/field/b-001`). The boundary polygon and all **six** plan
   points (`PT-001`…`PT-006`) render on `<BoundaryMap>` — flat brand-coloured
   background, no satellite imagery (expected, see below), gold pins for
   `pending`. A horizontal strip below the map repeats the six points as
   large tap targets. Tap `PT-001`.
3. **Capture** (`/capture/b-001/pp-001`). GPS starts acquiring immediately
   (shows "Acquiring GPS…"; on a browser with no location permission or in a
   headless/sandboxed environment it will honestly report "GPS unavailable"
   rather than hang — capture still proceeds). Tap the **Label** photo tile
   → the browser's camera-permission prompt appears → grant it → a live
   `getUserMedia` preview renders in-app → tap **● Shutter** → the tile
   updates with a real thumbnail and a "1 photo" badge. Repeat for **Core**
   and **Site** (or leave one short — a "Missing: …" badge appears and Save
   stays enabled regardless, per v02 §3's "missing data flags, it does not
   drop"). Scan or type a barcode (manual entry is always visible beside the
   scan button, tagged "Manual entry"/"Scanned"). Pick a couple of condition
   chips. Tap **Save** — writes locally in one transaction and returns to
   Field in well under a second; `PT-001`'s tile now shows sampled.
4. **Outbox** (`/outbox`, bottom nav). Shows **Pending: 5** (the visit,
   sample point, bag, and however many photo/condition rows the capture
   produced), photo megabytes waiting, "Never synced yet." Tap **Sync now** —
   under plain `vite dev` this genuinely fails (no functions runtime behind
   the dev server), and the screen shows *why*, per-record: `sync endpoint
   unreachable (HTTP 200)` with a note that functions aren't served under
   plain `vite dev`. This is the Outbox screen doing exactly its job — a
   real failure, a legible reason, not a spinner. Run the same flow under
   `netlify dev` (or a deployed preview) and Sync now reaches the real
   `/v1/sync/batch` function instead.

No console error at any step, checked by hand against the dev server's own
log across three full runs (see Gate).

---

## Landed

| Task | Files | What it does |
|---|---|---|
| B4 · Today | `src/app/screens/today/TodayScreen.tsx` | Boundary cards (progress ring, acres, tap-to-call), outbox/expiry status strip, first-run bundle download. `FEATURE_YESTERDAYS_FLAGS = false` — the empty slot (`YesterdaysFlagsSlot`) exists in code, never rendered, per the explicit instruction to build the slot and not the v1.5 feature |
| B5 · Field | `src/app/screens/field/FieldScreen.tsx` | `<BoundaryMap>` (real, `map-surface`'s B3) with the boundary polygon + six plan points, coarse (`enableHighAccuracy: false`) device position, tap-pin → Capture, long-press → field-added point, a point strip as a fallback/companion to tapping pins directly |
| B7 · Barcode | `src/app/screens/capture/BarcodeField.tsx` | ZXing (`@zxing/browser`) continuous scan, torch toggle (feature-detected), manual entry always visible and permanently tagged `scan`/`manual_entry`. Barcode value is **never** trimmed/altered — passed through verbatim on every keystroke and every scan |
| B7 · Capture shell + wiring | `src/app/screens/capture/CaptureScreen.tsx`, `CameraTile.tsx`, `CaptureCameraPanel.tsx` | Layout, position/barcode/photos/conditions/deviation/depth-cores/note sections, the Save gate (blocks only on an unanswered block-threshold deviation reason — everything else flags, never drops) |
| B11 · Outbox | `src/app/screens/outbox/OutboxScreen.tsx` | Pending/syncing/failed/synced counts, pending photo MB, last-synced-relative-time, **Sync now** (real `OutboxWorker` + a `fetch`-based transport to `/v1/sync/batch`), per-record list with `entity_type`, short id, state badge, and `last_error` text, per-record **Retry** on failed rows |
| Down-sync client | `src/app/shell/bundle/{client,apply,queries}.ts` | Fetches the assignment bundle (network first, F0.7-fixture fallback second — see below), applies it to the device SQLite tables (`clearBundleTables` + inserts, contract §2 replace-never-patch), and the read helpers Today/Field/Capture all share |
| Visit resolution | `src/app/shell/visit.ts` | Read-only lookup of an existing `in_progress field_visit` for a boundary, or a freshly minted (unpersisted) `FieldVisitPayload` for `CaptureSession.save()` to write transactionally — see "A mid-wave course correction" |
| Outbox reads | `src/app/shell/outbox-queries.ts` | Per-record list, last-synced timestamp, pending photo bytes — reads the `sync-spine`-owned `outbox`/`media` tables directly; no write, no edit to `src/sync/**` |
| Device id | `src/app/shell/device-id.ts` | `localStorage`-backed UUIDv7, injectable storage for tests. Auth/enrolment is out of scope this wave; every wire payload needing `device_id` needed *something* stable |
| Pure logic + tests | `src/app/screens/capture/offset.ts` (+ test) | `classifyOffset(offsetM, warnM, blockM)` — the one non-trivial decision this screen makes about `CaptureSession`'s advisory offset that isn't already the session's job |

## A mid-wave course correction: migrating onto `CaptureSession`

I built a first version of Capture directly against `@app/capture/gps.js` and
`@app/capture/camera/{intake,pipeline,types}.js` (what existed at wave start
per `SONNET_TASKS_STATUS.md`), including my own OPFS photo store and EXIF
parser. Partway through, `capture-integrity` landed `CaptureSession`
(`@app/capture/index.js`) — a much better-built, transactional, single-door
API covering exactly this screen's needs, plus two real integrity defects in
what I'd built (`src/app/shell/media/exif.ts` silently shifted every EXIF
timestamp by the device's timezone offset; `getPhotoStore()` fell back to an
in-memory store that would lose a day's photographs on reload). They flagged
both in `.claude/fleet/reports/capture-integrity-wave2.md` and
`integration/requests-b.md`.

I rewrote rather than patched: deleted `src/app/shell/media/{exif,photo-store}.ts`
outright, rebuilt `CaptureScreen.tsx`/`CameraTile.tsx` against
`createCaptureSession`, added `CaptureCameraPanel.tsx` (one shared camera
preview + shutter across all three role tiles, rather than one `getUserMedia`
instance per tile), and turned `visit.ts` from a DB-writing helper into a
read-only resolver so `session.save()`'s own transaction is the only thing
that writes `field_visit`. Appended the closure to `integration/requests-b.md`
(reproduced there in full: which of their four numbered items closed and
how). This is also why `CaptureScreen.tsx` and `FieldScreen.tsx`/
`TodayScreen.tsx`/`OutboxScreen.tsx` show as **modified** in `git status`
rather than the whole capture path being new — the first pass is fully
superseded, not layered under the second.

One correctness bug this surfaced and fixed **before** it shipped: an
earlier two-effect version of `CaptureScreen` raced "spec/plan-point finished
loading" against "session already constructed" — the loser was a session
permanently missing its advisory-offset seed. Caught by re-reading my own
effect dependencies while writing this report, not by a test; merged into one
linear effect. Documented in the file's own comment so it doesn't get
re-split by someone chasing a lint warning later.

## Contract or interface changes others need

None published. This wave **consumed** two contracts already published by
others rather than changing any:

- `<BoundaryMap>`'s prop API (`map-surface`, wave 1) — used as documented,
  `tilePackUrl={null}` always (see below), no second MapLibre instance.
- `CaptureSession`'s API (`capture-integrity`, wave 2, reproduced in full in
  their report) — used as documented; no gap found that needed a request
  beyond the four in `integration/requests-b.md`, all now closed.

The one new thing another screen might want to reuse: `src/app/shell/bundle/
queries.ts`'s read helpers (`listBoundarySummaries`, `listPlanPoints`,
`getBoundary`, `getPrimarySpec`, `getRefLabs`, `getRefConditionCodes`,
`getLatestBundleManifest`) are typed and exported for any future screen
(Storage, Skip) that wants bundle-derived data without hand-rolling SQL
again — not required reading, just there.

## Expected, not a bug: no satellite basemap

Per the task brief, confirmed and not worked around: `tile_pack.url` in the
demo fixture (`https://tiles.example.com/f26-nd-w-01.pmtiles`) does not
resolve, and B13 (the real PMTiles route-pack builder) is wave 3. `FieldScreen`
always passes `tilePackUrl={null}` to `<BoundaryMap>` — never a live network
style URL, matching that component's own prop contract — so the map renders
its flat brand-coloured background with the boundary and six pins drawn on
top. I did not add a fallback basemap or a network style URL anywhere.

## Stopped, and why

1. **No dev-time proxy from `vite dev` to the Netlify functions runtime
   exists in this repo**, and `vite.config.ts` is orchestrator-owned, so I
   could not add one. `fetchAssignmentBundle()` (`bundle/client.ts`) and the
   Outbox's `Sync now` transport both try the real endpoint first, every
   call, and fall back/report failure honestly rather than special-casing
   "dev." Verified by hand: `curl /v1/assignments/bundle` under plain
   `vite dev` returns HTTP 200 with `text/html` (Vite's SPA fallback, not a
   404) — `res.json()` on that throws, which the client's own try/catch turns
   into the fixture fallback. Locked in as a test
   (`bundle/client.test.ts`, "falls back … when plain vite dev answers 200
   with its SPA-fallback index.html"), not left as an assumption.
2. **`local_status` is not preserved across a second bundle apply.**
   `applyBundleToDevice` wipes and rewrites `sample_plan_point` wholesale
   (contract §2 replace-never-patch), and `local_status` is a device-local
   column bolted onto that same table. Guarded by only ever calling apply
   once per device (gated on `bundle_manifest` already holding a row) — a
   real "refresh assignments" action that needs to merge, not just replace,
   is out of scope this wave and named in `bundle/apply.ts`'s own header
   comment rather than solved.
3. **One active `field_visit` per boundary, reused across every capture in
   that boundary.** v02 doesn't specify how a visit's lifecycle maps to a UI
   session; a single reused `in_progress` row per boundary is the smallest
   thing that lets multiple captures share a real parent without inventing
   visit start/end UI. Named in `visit.ts`'s header.
4. **Multi-spec-per-boundary is not wired.** The demo fixture carries exactly
   one `project_sampling_spec` row, so `getPrimarySpec()` (`bundle/
   queries.ts`) reads "the first spec on file," documented in its own
   comment as wrong the day a second spec exists and `assigned_boundary.
   spec_id` needs to be threaded through instead.
5. **No Skip entry point existed anywhere in the app before this wave** —
   `skipPath()` had a route (`App.tsx`) but nothing navigated to it. I added
   one ("Can't sample — skip" in Capture's header, for existing plan points
   only) because I own that route entry per the fleet boundary
   ("`screens/skip/**` is `spec-transcriber`'s; you own the route entries
   that reach them") — I did not touch `SkipScreen.tsx`'s contents.
6. **Photo removal ("I don't like this shot, retake it") has no UI.**
   `CaptureSession.removePhoto(mediaId)` exists and works; wiring an ✕ on
   each thumbnail is a small, real follow-up I cut for time rather than for
   a design reason.
7. **v02 §11 criteria 6 (90-second point) and 7 (ten-hour battery day) are
   not simulated anywhere in this wave**, per the explicit instruction that
   a test claiming to cover them would be a false claim. Nothing here makes
   that claim.

## Needs from another agent

Appended in full to `integration/requests-b.md` (the closure of
`capture-integrity`'s four items — see above). Nothing new outstanding: both
`<BoundaryMap>` and `CaptureSession` exported everything this wave needed.

## Files touched

```
 M src/app/screens/capture/CaptureScreen.tsx    rewritten (twice — see "course correction")
 M src/app/screens/field/FieldScreen.tsx        B5, new content
 M src/app/screens/outbox/OutboxScreen.tsx      B11, new content
 M src/app/screens/today/TodayScreen.tsx        B4, new content
 M integration/requests-b.md                    appended (closure of capture-integrity's 4 items)
?? src/app/screens/capture/BarcodeField.tsx      B7
?? src/app/screens/capture/CameraTile.tsx        B7 (rewritten as a dumb button post course-correction)
?? src/app/screens/capture/CaptureCameraPanel.tsx  B7 (new post course-correction)
?? src/app/screens/capture/offset.ts             + offset.test.ts
?? src/app/shell/bundle/                         client.ts (+.test.ts), apply.ts (+.test.ts), queries.ts
?? src/app/shell/visit.ts                        + visit.test.ts (rewritten post course-correction)
?? src/app/shell/outbox-queries.ts
?? src/app/shell/device-id.ts                    + device-id.test.ts
```

Not mine, concurrent this wave, listed only to confirm nothing of mine landed
there: `src/app/capture/**` (`capture-integrity`), `src/app/components/
{DepthCoresToggle,DeviationPicker}.tsx`, `src/app/screens/{skip,storage}/**`
(`spec-transcriber`), `netlify/functions/assignments-bundle.ts` +
`src/server/assignments/bundle.ts` (`server-endpoints`). `src/app/App.tsx`
shows modified by `spec-transcriber` (wiring Skip/Storage routes) — outside
their declared paths per FLEET.md, but I read the diff, confirmed it's
exactly the two `<Route>` swaps my own wave-1 report asked whoever ran wave 2
to make, and left it rather than re-doing identical work.

`src/app/App.tsx`, `src/app/shell/{AppShell,FocusShell,ErrorBoundary,
UpdateBanner,ScreenPlaceholder,routes}.tsx`, `src/app/shell/db/**`,
`src/app/styles/global.css`, `index.html`, `src/main.tsx` — all wave-1,
unmodified this wave.
