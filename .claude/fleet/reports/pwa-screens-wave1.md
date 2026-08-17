# pwa-screens — wave 1

**Tasks:** B1 (PWA shell, service worker, routing, OPFS + `wa-sqlite` bootstrap)

**Gate:** `npm run typecheck && npm test` → **pass.** 19 test files, **159 passed, 1
skipped** (160 total — up from the 116/116 stated at wave start; the delta is my 8 new
tests plus whatever `map-surface`/`defect-rules` landed concurrently, not re-audited
here). The 1 skip is `wa-sqlite-opfs.browser.test.ts`'s real-OPFS smoke test,
self-skipped because neither jsdom nor this sandbox has a browser with
`navigator.storage.getDirectory` — see "Stopped, and why."
(Note: this ran against a tree `map-surface` was still writing to concurrently. Its
`src/shared/map/**` tests were green when I ran the gate; per FLEET.md §4.5 that is not
my claim to make authoritative — `fleet-integrator` re-runs it.)

`npm run build` also succeeds (full production Vite build, wasm asset bundled, service
worker generated) — run and inspected by hand, then `dist/` removed since it's
gitignored and not meant to be committed.

`npm run dev` serves the shell at `/` with HTTP 200, and every file I wrote transforms
cleanly through Vite's dev pipeline (checked by curling each module path directly — see
"Stopped, and why" for the one thing that check *cannot* prove).

## Landed

| Task | Files | What it does |
|---|---|---|
| B1 | `src/main.tsx`, `index.html` (edited) | Already existed from an earlier F0.1 pass (Sonnet, pre-wave); left `main.tsx` untouched, added a comment to `index.html` explaining the manifest-link duplication (see below). |
| B1 | `src/app/App.tsx` | Router root: `DeviceDbProvider` → `BrowserRouter` → two layout routes (`AppShell` for Today/Outbox/Storage, `FocusShell` for Field/Capture/Skip) → the six screens. |
| B1 | `src/app/shell/routes.ts` (+`routes.test.ts`) | The route table — `ROUTE_PATHS`, path builders, `NAV_DESTINATIONS`. Documents the routing and layout conventions I had to invent (see "Stopped, and why"). |
| B1 | `src/app/shell/AppShell.tsx` | Persistent layout: SW update banner, error boundary, 64 dp bottom nav (Today / Outbox / Storage). |
| B1 | `src/app/shell/FocusShell.tsx` | Distraction-free layout for Field/Capture/Skip — no nav, still the update banner and error boundary. |
| B1 | `src/app/shell/ErrorBoundary.tsx` | Catches a crashed screen so the rest of the shell (nav, ability to reach Outbox) survives it. |
| B1 | `src/app/shell/UpdateBanner.tsx`, `src/app/shell/pwa-client.d.ts` | Service-worker update surface via `virtual:pwa-register/react`. Non-blocking, `registerType: 'prompt'` (from `vite.config.ts`, not mine but consumed correctly) — never swaps the app under a sampler's hands mid-form. |
| B1 | `src/app/shell/db/wa-sqlite-opfs.ts` (+`.browser.test.ts`), `wa-sqlite-examples.d.ts` | The real `SqlDatabase` implementation: `wa-sqlite`'s async/Asyncify build + `OriginPrivateFileSystemVFS` (OPFS), main thread, no Worker, no extra dependency. Full reasoning for that VFS choice (not `AccessHandlePoolVFS`) is in the file header. |
| B1 | `src/app/shell/db/device-db.ts` (+`.test.ts`), `DeviceDbProvider.tsx` | Orchestration: open a connection → `bootstrapDeviceDb()` (F0.6) → memoised singleton. DI'd connection factory so the migration logic is tested against `tests/support/node-sqlite.ts`'s real-SQLite fake without a browser. React context/hook (`useDeviceDb`) is the app-facing surface. |
| B1 | `src/app/shell/ScreenPlaceholder.tsx` | The generic stand-in every one of the six routes renders until its real screen lands. Shows live device-DB status so the bootstrap is visible, not just asserted. |
| B1 | `src/app/screens/today/TodayScreen.tsx`, `screens/field/FieldScreen.tsx`, `screens/capture/CaptureScreen.tsx`, `screens/outbox/OutboxScreen.tsx` | The four screens I own, wired to their routes, each a thin `ScreenPlaceholder` wrapper naming the wave-2 task that replaces it. `screens/skip/**` and `screens/storage/**` were **not created** — see below. |
| B1 | `src/app/styles/global.css` | Structural resets only (box-sizing, safe-area/overscroll behaviour). No colour values — see "palette seam" below. |
| B1 | `public/icons/icon-192.png`, `icon-512.png` | Two solid-colour (theme-colour) placeholder PWA icons. `vite.config.ts`'s manifest referenced `/icons/icon-{192,512}.png` and no `public/` directory existed, so the manifest's icon URLs 404'd. Not brand assets — just enough for the manifest to resolve without a broken-image console warning. Flag for design review before ship. |

## Contract or interface changes others need

**The DB handle wave 2 screens consume** (`src/app/shell/db/`):

```ts
// device-db.ts
export interface DeviceDbHandle {
  db: SqlDatabase;           // src/shared/db/types.ts — exec/run/all
  migration: MigrateResult;  // src/shared/db/schema.ts
}
export function getDeviceDb(): Promise<DeviceDbHandle>;   // memoised singleton

// DeviceDbProvider.tsx — the React-facing surface. Use this, not getDeviceDb() directly.
export function useDeviceDb(): 
  | { status: 'loading' }
  | { status: 'ready'; db: SqlDatabase; migration: MigrateResult }
  | { status: 'error'; error: Error };
```

`OutboxStore`/`OutboxWorker` (`src/sync/**`, already real per `sync-spine`'s A3) both
just take a `SqlDatabase` in their constructor — B11 (Outbox screen) wires
`new OutboxStore(state.db)` off `useDeviceDb()`'s `ready` state. Nothing new needed from
`sync-spine`.

**The route table** (`src/app/shell/routes.ts`):

```ts
export const ROUTE_PATHS = {
  today: '/',
  field: '/field/:boundaryId',
  capture: '/capture/:boundaryId/:pointId',
  captureNew: '/capture/:boundaryId/new',   // long-press bare ground, no plan_point_id yet
  skip: '/skip/:boundaryId/:pointId',
  outbox: '/outbox',
  storage: '/storage',
} as const;
// + fieldPath(), capturePath(), captureNewPath(), skipPath() builders
// + NAV_DESTINATIONS: the 3 persistent bottom-nav tabs (today/outbox/storage)
```

**Shell layout contract:** two layout routes in `App.tsx` — `<AppShell>` (persistent
bottom nav; Today/Outbox/Storage) and `<FocusShell>` (no nav; Field/Capture/Skip). Both
render `<UpdateBanner/>` + `<ErrorBoundary><Outlet/></ErrorBoundary>`. B5/B7/B10/B11/B12
should build their screens assuming this wrapper already exists — do not add a second
error boundary or another SW-update surface.

**Skip and Storage routing — read this before B10/B12 land:** `App.tsx` currently
renders `<ScreenPlaceholder name="Skip" .../>` and `<ScreenPlaceholder name="Storage"
.../>` **inline**, not via `import` from `screens/skip/**`/`screens/storage/**`, because
those directories do not exist yet this wave and a static import of a nonexistent path
would fail `npm run typecheck` today. **`pwa-screens` (me, in a later wave) is the one
who swaps those two `<Route>` elements to import the real components once B10/B12 land**
— `App.tsx` is my exclusive path, so `spec-transcriber` cannot wire the route itself even
after building the screen. This is a real follow-up action item for wave 2, not an
open question: whoever runs the wave-3 `pwa-screens` task should check for
`screens/skip/index.tsx` / `screens/storage/index.tsx` and wire them in.

## Stopped, and why

1. **`vite.config.ts`'s service-worker `globPatterns` doesn't precache the wa-sqlite
   wasm binary.** I confirmed this by hand with `npm run build`: the workbox precache
   manifest in `dist/sw.js` lists 14 entries (JS/CSS/HTML/icons/manifest) and does
   **not** include `assets/wa-sqlite-async-*.wasm` (1.1 MB), because
   `globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}']` has no `wasm`
   extension — this is pre-existing in `vite.config.ts`, not something I introduced, and
   `vite.config.ts` is orchestrator-only. **This matters**: if a device has never
   fetched that wasm file with the SW's blessing, and the browser's regular HTTP cache
   has evicted it, opening the device database while fully offline (radio off, per this
   agent's own non-negotiable) can fail on `import('wa-sqlite/dist/wa-sqlite-async.mjs')`.
   **The fix is a one-line change I cannot make**: add `wasm` to the `globPatterns`
   extension list (`'**/*.{js,css,html,svg,png,ico,webmanifest,wasm}'`), or add an
   explicit `runtimeCaching` entry for it. Flagging rather than guessing at
   `vite.config.ts`.
2. **Duplicate `<link rel="manifest">` in the production build, harmless but real.**
   `vite-plugin-pwa`'s `BuildPlugin` unconditionally injects its own manifest link into
   `</head>` on `npm run build`, regardless of what's already in `index.html`.
   `vite-plugin-pwa`'s `DevPlugin` does the *opposite* — it only touches `index.html`
   when `devOptions.enabled` is `true` in `vite.config.ts`, which it currently is not, so
   `npm run dev` injects nothing. I kept the manual `<link>` in `index.html` (mine to
   edit) because removing it would leave dev mode with no manifest at all; the cost is a
   second, functionally-inert manifest link in `dist/index.html` (verified by hand).
   Either accept it, or the orchestrator sets `devOptions.enabled: true` in
   `vite.config.ts` and I'd remove the manual tag in the next wave — not my call to make
   unilaterally since it also changes dev-mode SW registration behaviour.
3. **Route-naming and layout conventions were not specified anywhere** (v02 §2 names the
   six screens, not URL shapes or which ones share a nav bar) — I made both calls and
   documented the reasoning directly in `routes.ts`'s header rather than inventing them
   silently: `camelCase` params matching the wire contract's field names
   (`boundaryId`~`boundary_id`, `pointId`~`plan_point_id`); Today/Outbox/Storage keep a
   persistent bottom nav, Field/Capture/Skip drop it for full-screen focus. Both are
   easy to change — nothing outside `src/app/shell/routes.ts`, `AppShell.tsx`,
   `FocusShell.tsx` hard-codes a path string.
4. **Service-worker update policy** — v02 doesn't fix one, so I chose `registerType:
   'prompt'` reasoning (already set in `vite.config.ts`, which I did not write but do
   rely on and should flag as load-bearing): `autoUpdate` would let the SW swap the
   app's JS out from under a sampler mid-capture-form; `prompt` downloads in the
   background and only offers to activate once idle. If wave 2/3 wants
   force-update-at-next-launch instead (e.g. to guarantee a defect-rule fix reaches every
   device by the next sync), that's a `registerType` change in `vite.config.ts`, not
   here.
5. **`AccessHandlePoolVFS` vs `OriginPrivateFileSystemVFS`** — not unspecified by the
   plan, but worth naming as a deliberate trade rather than a default: the faster,
   Worker-hosted, `FileSystemSyncAccessHandle`-based VFS needs a dedicated Worker plus a
   Comlink-style RPC boundary (`comlink` is a `wa-sqlite` devDependency only, not an app
   dependency — adding it is an orchestrator call, not mine to make silently). I used the
   main-thread, async-build VFS instead. If capture-day performance profiling later shows
   this is too slow, that's a follow-up with its own dependency ask.
6. **The OPFS/wa-sqlite driver itself is untestable in this sandbox and I said so in the
   code, not just here.** No headless browser is available (checked: no
   `playwright`/`puppeteer` in `node_modules`, no system Chrome/Chromium binary), and
   jsdom (`npm test`/`npm run test:browser`'s environment) does not implement
   `navigator.storage.getDirectory`. `wa-sqlite-opfs.browser.test.ts` self-skips its one
   real assertion and always runs a second test that records whether OPFS was available
   — visible, not silently green. What **is** tested end-to-end against real SQLite
   (`tests/support/node-sqlite.ts`, Node's `node:sqlite`) is the migration/bootstrap
   orchestration in `device-db.ts` — two tests, one proving a fresh connection reaches
   `TARGET_SCHEMA_VERSION` and the outbox table is queryable, one proving idempotency on
   a second call. That is the honest boundary of what this environment can verify; the
   rest needs a real Chrome/Edge/Android WebView, by hand, before B4/B11 build on top of
   it in wave 2.
7. **"Yesterday's flags"** — no empty slot built this wave. It belongs on the Today
   screen (B4, wave 2), which I did not build content for — `routes.ts`/`App.tsx` just
   reach a placeholder. Noting so wave 2 doesn't have to re-discover the feature-flag
   requirement from the plan doc.

## Needs from another agent

Both items below are `vite.config.ts` changes, which is orchestrator-only — nothing to
append to `integration/requests-b.md` since that file is for cross-*lane* code needs, and
this is a same-lane infra file I'm not permitted to touch, not another agent's owned
source path. Recording here per this report's "Stopped, and why" instead:

1. Add `wasm` to `vite.config.ts`'s `workbox.globPatterns` extension list (or an
   equivalent `runtimeCaching` rule) so the wa-sqlite wasm binary survives full offline
   after first install. **This is the one gap that could make this wave's OPFS bootstrap
   fail exactly the scenario it exists for** (a week offline, radio off).
2. Optional: `devOptions.enabled: true` would let `npm run dev` exercise real
   service-worker behaviour and let me drop the manual `<link rel="manifest">` from
   `index.html` (removing the harmless build-time duplicate). Not blocking.

## Files touched

```
 M index.html
 M src/app/App.tsx
 M src/app/styles/global.css
?? public/                        (icon-192.png, icon-512.png — placeholders, see above)
?? src/app/screens/                (today/, field/, capture/, outbox/ — mine; skip/, storage/ NOT created, see above)
?? src/app/shell/                  (AppShell.tsx, FocusShell.tsx, ErrorBoundary.tsx, UpdateBanner.tsx,
                                     ScreenPlaceholder.tsx, routes.ts(+.test.ts), pwa-client.d.ts, db/**)

-- not mine, concurrent map-surface wave-1 output, listed here only because `git status`
   is shared-tree and this confirms nothing of mine landed there:
?? .claude/fleet/reports/map-surface-wave1.md
?? src/shared/map/
```

`src/main.tsx` and the pre-existing part of `index.html` (everything but the new
comment) were already correct from an earlier F0.1 pass and needed no changes — noted in
"Landed" rather than reported as new work.
