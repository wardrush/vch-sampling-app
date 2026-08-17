# wave 1 — integration gate

**Agent:** `fleet-integrator` (Opus 5) · **Date:** 2026-08-17
**Scope:** the whole tree — commit `93a2773` (partial wave-1) plus all uncommitted work.
**Verdict: CONDITIONAL GO for wave 2.** One blocker in `<BoundaryMap>` gates task **B5
only**; everything else in wave 2 may proceed. Details in §5.

---

## 1. Authoritative gate

Run by this agent, alone, on the complete tree. Nothing else was writing.

| Command | Exit | Result |
|---|---|---|
| `npm run typecheck` | **0** | Clean. 0 errors. |
| `npm test` | **0** | **19 test files · 159 passed · 1 skipped (160 total)** |
| `npm run lint` | **2** | **FAIL — config error, no rules ever executed. Pre-existing.** |
| `npm run build` | **0** | 68 modules, `dist/sw.js` generated, precache 14 entries / 271.57 KiB |

### Test counts reconcile

`pwa-screens` claimed 159 passed / 1 skipped — **exactly correct**. The 1 skip is
`wa-sqlite-opfs.browser.test.ts`'s real-OPFS assertion, which self-skips and prints
`OPFS available in this test environment: false`. That is an honest skip, not a
quarantine: it fails loudly-in-writing rather than passing vacuously, and a second
test always runs to record the environment. Left as is.

The three earlier claims (`defect-rules` 116, `spec-transcriber` 116, `map-surface`
152) were all accurate *at their moment*; per §4 rule 5 none was authoritative. They
compose to today's 159 without contradiction.

### Lint is red and it is not wave 1's fault

```
ESLint: 9.39.5
ESLint couldn't find an eslint.config.(js|mjs|cjs) file.
```

`package.json` pins `eslint: ^9.11.1`; the repo ships `.eslintrc.cjs`, the pre-flat
format ESLint 9 dropped. `.eslintrc.cjs` was last touched in `46c38d8`, **before**
wave 1, and neither it nor `package.json` is dirty. **`npm run lint` has never
executed a single rule on this repository.** No wave-1 agent caused it and none could
fix it — both files are orchestrator-only (§4 rule 3).

Consequence worth stating plainly: every "green gate" in this repo's history, mine
included, is typecheck + test only. There is no lint signal at all, and the
`eslint-disable` comments in `BoundaryMap.tsx` have never suppressed anything real.

---

## 2. Report-vs-diff reconciliation

One line per agent. The diff is fact; the reports are claims.

| Agent | Diff supports report? | Mismatch |
|---|---|---|
| `defect-rules` | **Yes** | None. 4 rules + `index.ts` + 22 tests, all present, all within its agent file's paths. |
| `spec-transcriber` | **Yes** | 9 files under `src/app/components/`, exactly as listed. One self-inconsistency, §4.6. |
| `map-surface` | **Yes, but the headline conceals a gap** | 13 files as listed. "152/152, 5 test files" is true; what it does not say is that **`BoundaryMap.tsx` itself has zero tests**. §4.1. |
| `pwa-screens` | **Yes — most accurate report of the four** | Both `vite.config.ts` claims verified true by independent build inspection. One unowned path, disclosed by the agent itself. §3. |

### The interrupted-run inheritance checks out

`map-surface` claims it inherited six modules from the killed run and verified them
for truncation. I verified this **independently**, not on its word:

- Brace balance across all 8 `src/shared/map` source files: balanced, no exceptions.
- Every file terminates on a closing token, none mid-statement.
- No `TODO`/`FIXME`/stub/`throw new Error('unimplemented')` anywhere in the directory.
- `tsc --noEmit` clean; 36 map tests pass.

**No truncation damage. The inherited modules are sound.** The re-spawn-to-finish
approach worked.

### Claims I checked and found true

- `spec-transcriber` "no files flattened to repo root" — **true**, root is clean.
- `pwa-screens` "wasm not precached" — **true**, verified in `dist/sw.js`. §4.3.
- `pwa-screens` "duplicate manifest link in production" — **true**, `dist/index.html`
  lines 17 and 21. §4.7.
- `map-surface` "no second MapLibre setup" — **true**, `new maplibregl.Map` appears
  once in the repo.
- `defect-rules` / `map-surface` "no dependency added" — **true**, `package.json` and
  `package-lock.json` are byte-identical to `HEAD`. One lockfile writer held.

---

## 3. Path-boundary audit

**No agent wrote into another agent's owned paths. No work was silently lost.**

- **Repo root: clean.** No `src_shared_codes_*.ts`-style path-flattened files. The
  known prior failure did not recur.
- **`src/app/` three-way boundary held.** `src/app/screens/skip/**` and
  `src/app/screens/storage/**` **were not created** — confirmed by `find`. `App.tsx`
  renders `<ScreenPlaceholder name="Skip">` / `name="Storage"` inline at
  `ROUTE_PATHS.skip` / `.storage`, each naming `spec-transcriber (B10/B12, wave 2)` as
  owner. **No duplicate route, no orphaned route**; a `path="*"` catch-all redirects to
  Today. Exactly as reported.
- **No duplicate implementations.** One MapLibre init, one wa-sqlite/OPFS bootstrap
  (all under `shell/db/`), one palette. The wave-1 failure mode from §0 did not recur.
- **Orchestrator-owned files untouched:** `package.json`, `package-lock.json`,
  `netlify.toml`, `vite.config.ts`, `CLAUDE.md`, root `*.md`. `.claude/` writes are the
  two reports only.
- **`integration/requests-{a,b,c}.md` untouched** this wave. Correct — no agent had a
  cross-*lane* code need.

### One write outside owned paths — minor, disclosed

`pwa-screens` created **`public/icons/icon-192.png`** and **`icon-512.png`**.
`public/` is not in its owned-path list — and is owned by *no agent in the roster*. It
disclosed this in its own report with the reasoning: `vite.config.ts`'s manifest
already referenced `/icons/icon-{192,512}.png` and no `public/` existed, so the
manifest's icon URLs 404'd.

**Assessment: accept.** It is two placeholder PNGs, it repaired a real break in an
orchestrator-owned config it could not edit, it flagged them as non-brand assets for
design review, and it named them in "Files touched". This is the boundary being
handled well, not violated. **Action for the orchestrator: assign `public/**` to an
owner in FLEET.md §1** — an unowned path that agents need is a rule-2 gap, not an
agent error.

### A roster/agent-file discrepancy to fix

FLEET.md §1 lists `defect-rules` as owning only `src/server/defects/rules/**`. Its own
agent file (`.claude/agents/defect-rules.md`) also grants
`tests/unit/defect-rules*.test.ts`. It wrote that file. Per §4 rule 2 the **agent
file** is binding, so this is **not a violation** — but the two should be reconciled so
the next integrator does not read it as one.

---

## 4. Defects found by this gate

Ordered by severity. Items 1, 2, 4 and 5 were reported by **no agent**.

### 4.1 · BLOCKER — `<BoundaryMap>` silently drops UUID point ids · owner `map-surface`

**This is the finding of the wave, and it sits on the build's one cross-lane
dependency.**

`pointsToGeoJSON` (`src/shared/map/geojson.ts:15`) sets `id: p.id` as a **string**.
MapLibre's GeoJSON→vector-tile wrapper discards any feature id it cannot coerce to an
integer. From `node_modules/maplibre-gl/dist/maplibre-gl-dev.js:33905`, its own
comment:

```js
// If the feature has a top-level `id` property, copy it over, but only
// if it can be coerced to an integer, because this wrapper is used for
// serializing geojson feature data into vector tile PBF data, and the
// vector tile spec only supports integer values for feature ids
if ('id' in feature && !isNaN(feature.id)) {
    this.id = parseInt(feature.id, 10);
}
```

Measured against the two consumers' actual id types:

```
sampler id (plan_point_id / sample_uid): 01a00d8e-4c36-7a53-b1be-d20a9412a142
  isNaN(id) = true  -> guard FAILS -> feature.id DROPPED
ingest id (source_row_no as string)    : 42
  isNaN(id) = false -> guard PASSES -> id = 42
```

`sample_uid` is typed `Uuid7` in `src/shared/contract/entities.ts:41`; the design spine
makes all client identity UUIDv7. So on the sampler Field screen:

1. **`setFeatureState({source, id: '<uuid>'}, {hover:true})` binds to an id no rendered
   feature carries.** The `['boolean', ['feature-state','hover'], false]` paint
   expressions never evaluate true → **the hover highlight never renders, in either
   direction.** The bidirectional-hover contract B5 and C10 are told to build against
   is dead for B5.
2. **Worse: `onPointClick` never fires.** `BoundaryMap.tsx:257-261` does
   `const id = feature?.id != null ? String(feature.id) : null;` and only calls
   `onPointClick` when `id !== null`. With the id dropped, `feature.id` is `undefined`
   → `id` is `null` → **tapping a planned point never opens Capture.** That is the
   primary interaction of the whole field app.

**C10 (ingest preview) is unaffected** — numeric row numbers pass the guard. So
`map-surface`'s claim that the prop API "serves both consumers without compromise" is
correct *at the API level* and wrong *at the implementation level*, in a way that
happens to spare the consumer it was checked against.

**Why nothing caught it:** typecheck cannot see it, and `BoundaryMap.tsx` — 454 lines
containing every interaction behaviour — **has no test file.** The five test files
cover only the pure helpers (`geojson`, `style`, `colors`, `pmtiles-protocol`,
`scale`). "152/152 passing" is true and tells you nothing about this.

**Fix (map-surface's, not mine — I write no feature code):** add `promoteId: 'id'` to
the point (and boundary) GeoJSON source definitions in `installSourcesAndLayers`.
`pointsToGeoJSON` **already writes `id` into `properties`** (`geojson.ts:17`), so the
data is shaped for it — this is a one-line change per source. `promoteId` is
MapLibre's documented mechanism for exactly this and preserves string ids through
feature-state. Pair it with a test that asserts a UUID-id point round-trips through
`onPointClick`.

### 4.2 · HIGH — `rules.registry.test.ts` does not exist, and the code claims it does

`src/server/defects/rules/index.ts:13-15` states:

> `PENDING_A8_RULES` names what is still outstanding. `rules.registry.test.ts`
> asserts that every code in the contract's step-7 list is either implemented
> or listed there, **so a rule cannot go missing quietly.**

**That file has never existed** — `git log --all --diff-filter=A` finds no creation
commit. No test anywhere imports `PENDING_A8_RULES`. The comment predates wave 1 (it
came in with the Opus harness, `ba31364`), so this is not `defect-rules`' doing — but
it edited `index.ts` this wave and left the claim standing.

**This is a false claim of a safety net in the code record**, and the gap it was meant
to prevent has already opened. Computing the invariant by hand:

| Category | Codes |
|---|---|
| Implemented (6) | `BARCODE_DUPLICATE`, `NO_GPS_FIX`, `MISSING_REQUIRED_MEDIA`, `OFFSET_EXCEEDED_NO_REASON`, `MEDIA_GALLERY_SOURCED`, `DEPTH_SHORTFALL` |
| Pending A8 (2) | `CLOCK_DRIFT_SUSPECTED`, `EXIF_POSITION_MISMATCH` |
| Pipeline-raised (2) | `POINT_OUTSIDE_BOUNDARY`, `GEOM_INVALID` |
| Nightly-raised (1) | `PLAN_POINT_UNSAMPLED` |
| **Unaccounted (6 of 17)** | `GPS_ACCURACY_EXCEEDED`, `IMPORT_OPERATION_UNRESOLVED`, `IMPORT_CONTACT_UNRESOLVED`, **`BARCODE_UNREAD`**, **`LATE_SYNC`**, **`MANUAL_POSITION`** |

Three of those six are benign but uncategorised — `GPS_ACCURACY_EXCEEDED` is raised
inside `no-gps-fix.ts` (one rule, two codes, which the registry model does not
express), and the two `IMPORT_*` codes are raised by `src/ingest/commit/index.ts`.

**Three are genuinely orphaned: `BARCODE_UNREAD`, `LATE_SYNC`, `MANUAL_POSITION` are
defined in the code table and raised by nothing, anywhere, and listed pending by
nothing.** Exactly the "discovered in April" failure the comment promised was
impossible. Owner: `sync-spine` (harness/registry) with `defect-rules` for any rule
that follows.

### 4.3 · MEDIUM — wa-sqlite wasm not precached (severity assessment requested)

Verified independently. `vite.config.ts:18` has
`globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}']` — no `wasm`.
`dist/sw.js` contains **zero** occurrences of `wasm`; precache is 14 entries /
271.57 KiB while `dist/assets/wa-sqlite-async-DY3_ptqa.wasm` is **1,139.40 kB** and
absent. Note `maximumFileSizeToCacheInBytes` is already 5 MB, so **size is not the
obstacle — only the extension list is.**

**Does it block wave 2? No. Should it wait for wave 4? Also no.**

- It does not block wave 2 because nothing wave 2 builds depends on the precache being
  correct; in dev and CI the wasm is served from network/HTTP cache and the OPFS
  bootstrap works.
- But it directly negates B1's stated non-negotiable — *capture never blocks on the
  network*. A device that installs the PWA, has the browser evict the wasm from its
  ordinary HTTP cache, and then goes to a field with the radio off **cannot open its
  device database**. That is a lost sampling day, in a build whose whole premise is
  that a defect found in October waits a year.
- The fix is **one word** in an orchestrator-owned file:
  `'**/*.{js,css,html,svg,png,ico,webmanifest,wasm}'`.

**Recommendation: the orchestrator makes this change in the wave-1 commit.** It costs
nothing, it is in a file only the orchestrator may touch, and deferring a one-word fix
on the app's core durability promise to wave 4 is how it reaches a device.

### 4.4 · MEDIUM — the wave-2 test config trap

`vitest.config.ts` — the config `npm test` actually uses — is:

```ts
environment: 'node',
include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
```

Two problems land squarely on wave 2, which is the wave that writes screens:

1. **`*.test.tsx` is not in `include`.** A React component test named the natural way
   will be **silently not collected**. Vitest reports success for files it never ran.
   An agent would run the gate, see green, and report green — with its tests never
   having executed. There are no `.test.tsx` files today, so this is a trap that has
   not yet sprung.
2. **`environment: 'node'`** cannot render React regardless. The jsdom config lives in
   `vite.config.ts` and runs only under `npm run test:browser`, which is **not part of
   the gate** (I ran it separately: 1 passed, 1 skipped).

`vitest.config.ts` is orchestrator-owned. Wave 2 cannot write a working component test
without a change there. **This should be resolved before wave 2 spawns, not after it
reports green.**

### 4.5 · LOW — two independent colour sources, and the map's are not isolated

The requested palette check: **`src/app/styles/global.css` is clean** — structural
resets only, zero colour values, with a comment explaining exactly why. Every shell
file (`AppShell`, `FocusShell`, `ErrorBoundary`, `UpdateBanner`, `ScreenPlaceholder`)
imports `SEMANTIC_COLORS` from `@app/components/tokens`. **None defines a colour of its
own.** The app lane's one-file-swap invariant holds — `pwa-screens` did this properly.

The leak is elsewhere. `src/shared/map/**` carries its own hexes, independent of
`tokens/colors.ts`: `#2563eb`, `#1d4ed8`, `#ffffff`, `#6b7280`, `#111827`, `#e7e3d8`
(all Tailwind defaults — invented, not from any spec). `map-surface` honestly flagged
the *values* as unconfirmed. What it did not do is **isolate them**: `DEFAULT_BOUNDARY_FILL`
and `DEFAULT_BOUNDARY_STROKE` are named consts, but `#2563eb` and `#ffffff` also appear
inline at six sites in `BoundaryMap.tsx` (lines 138, 156, 175, 177, 190, 191). FLEET §4
rule 6's own example is about isolating an unconfirmable value into one place instead of
guessing it in three. When the real palette lands it is now a two-file, eight-site change.

### 4.6 · LOW — `Button.tsx:49` hard-codes a hex, in the token owner's own file

```ts
danger: {
  backgroundColor: '#cc0000',        // should be SEMANTIC_COLORS / COLORS.error600
  color: SEMANTIC_COLORS.buttonPrimaryText,
},
```

`#cc0000` *is* `COLORS.error600` — copied rather than referenced, in the one file whose
purpose is that the palette lives in one place. One-line fix, owner `spec-transcriber`.

### 4.7 · LOW — duplicate `<link rel="manifest">` in production

Confirmed: `dist/index.html` lines 17 and 21. `pwa-screens` caused it by adding a
manual tag, documented the trade-off in an HTML comment, explained that removing it
breaks dev mode, and offered the alternative (`devOptions.enabled: true`). Functionally
inert. **Accept as is, or take the `devOptions` change** — orchestrator's call.

### 4.8 · What I checked and found clean

- **No test claiming the real-hardware criteria.** v02 §11.6 (90-second point, timed in
  a field) and §11.7 (ten-hour day under 60% battery) are covered by **no test**, and no
  test mentions battery or hardware timing. Acceptance tests 01–05 map honestly to
  §11.1–§11.5. **There is no false claim in the record here** — the thing my brief
  warned about did not happen.
- **No vacuous assertions.** Every `toBe(true)` I inspected asserts a computed value.
  `tests/unit/schema-and-ingest.test.ts:267` is written oddly
  (`expect(write).toContain('IMPORT_OPERATION_UNRESOLVED'.length > 0 ? 'CURATED.SAMPLE_DEFECT' : '')`
  — an always-true ternary) but does make a real assertion. Cosmetic.
- **No contract change landed without a `schema-steward` announcement.**
  `src/shared/contract/**` is untouched this wave.

---

## 5. GO / NO-GO for wave 2

### CONDITIONAL GO

**GO for:** `ingest-lane` (C1–C6, C9) · `server-endpoints` (A9 nightly pair) ·
`spec-transcriber` (B9, B10, B12) · `pwa-screens` for **B4 (Today), B7 (barcode),
B11 (Outbox)**.

**NO-GO for B5 (Field screen) until §4.1 is fixed.** B5's two core interactions —
tap-a-pin-to-capture and pin/row hover — are non-functional for UUID ids. Building B5
against it produces a screen that typechecks, tests green, and does nothing when a
sampler taps a point.

### The fix that unblocks B5

**Add `map-surface` to wave 2** with a scoped task:

1. `promoteId: 'id'` on the point and boundary GeoJSON sources in
   `installSourcesAndLayers` (`src/shared/map/BoundaryMap.tsx`). The data already
   carries `properties.id`.
2. A `BoundaryMap` test that asserts a **UUIDv7-id** point round-trips through
   `onPointClick` and `hoveredPointId` — the coverage gap that let this through.

Disjointness holds: `map-surface` owns `src/shared/map/**`, no other wave-2 agent
writes there, so it runs concurrently with everything above. B5 and the fix can run in
the same wave — the repair is internal to the component and **does not change the prop
API**, so B5 codes against the same interface either way.

### Orchestrator actions before spawning wave 2

| # | Action | File | Why |
|---|---|---|---|
| 1 | Add `wasm` to `workbox.globPatterns` | `vite.config.ts` | §4.3 — one word, core durability promise |
| 2 | Add `*.test.tsx` to `include`; give component tests a jsdom project | `vitest.config.ts` | §4.4 — otherwise wave 2's screen tests silently never run |
| 3 | Migrate to `eslint.config.js` (flat) **or** pin `eslint@^8` | root + `package.json` | §1 — lint has never run |
| 4 | Assign `public/**` an owner | `FLEET.md` §1 | §3 — unowned path agents need |
| 5 | Reconcile `defect-rules` paths between §1 and its agent file | `FLEET.md` §1 | §3 |

Items 1 and 2 are the ones that matter. Item 2 in particular: without it, wave 2's
green is *less* meaningful than wave 1's, and the whole reason this gate exists is that
a subagent's green is not evidence.

---

## 6. Deduplicated block list — the next wave's real input

Every "I stopped because X was unspecified", merged across four reports. **Bolded
items were hit by more than one agent, which makes them the strongest signal here.**

| # | Unspecified | Raised by | Consequence today |
|---|---|---|---|
| 1 | **Glove/wind/low-sun palette hex values.** v02 §4.3 fixes the requirement, names no colour | **`spec-transcriber` + `map-surface`** | Two independent placeholder sets now exist (§4.5). **Two agents hit this — it is the wave's clearest missing decision.** Needs design review, not an agent |
| 2 | Drift tolerance (seconds) for `CLOCK_DRIFT_SUSPECTED` | `defect-rules` | Rule unimplemented, correctly listed pending. Belongs in `REF.PROJECT_SAMPLING_SPEC` |
| 3 | Distance threshold (metres) for `EXIF_POSITION_MISMATCH` | `defect-rules` | Same. v02 §9 says "needs a distance threshold" without naming one |
| 4 | Long-press threshold + move tolerance | `map-surface` | 500 ms / 10 px used, sourced from Android's `getLongPressTimeout()` default. Needs real-device confirmation |
| 5 | Map default colours; single-point fallback zoom (15); fit padding (32 px) | `map-surface` | Folded into #1 for colours; the camera constants are low-stakes |
| 6 | Route URL shapes and which screens keep a bottom nav | `pwa-screens` | Decided and documented in `routes.ts`; cheap to change, nothing outside three files hard-codes a path |
| 7 | Service-worker update policy | `pwa-screens` | `registerType: 'prompt'` inherited and defended (never swap the app mid-form). Confirm if force-update is wanted |
| 8 | OPFS/wa-sqlite unverifiable — no headless browser, jsdom lacks `navigator.storage` | `pwa-screens` | Migration orchestration *is* tested against real SQLite; **the OPFS driver itself is unexecuted.** Needs one manual pass on real Chrome/Android WebView **before B4/B11 build on it** |
| 9 | `AccessHandlePoolVFS` would need a Worker + `comlink` dependency | `pwa-screens` | Deliberately took the slower main-thread VFS rather than add a dependency unilaterally. Correct call under §4 rule 3 |
| 10 | "Yesterday's flags" empty slot not built | `pwa-screens` | Belongs to B4, wave 2. Noted so it is not re-discovered |

**Escalation health:** no agent stopped twice for the same reason, so nothing was
mis-tiered. Both haiku agents stopped precisely where their specs ran out and neither
invented a threshold — §4 rule 6 working as designed. The haiku bet is not yet settled;
`ingest-lane` in wave 2 is where it gets tested.

**Blocking pre-work reminder:** items 2 and 3 above are engineering-blocked on the same
kind of call as CLAUDE.md's five non-engineering items. Wave 4's A12 is still blocked on
the Snowflake service user — three days to approve, and per FLEET §3 that call *should
already have been made*. Nothing in wave 2 depends on it; wave 4 entirely does.

---

## 7. Summary

Wave 1 landed well. The interrupted-run recovery worked and left no truncation. Path
discipline held completely — no root flattening, no cross-agent writes, no duplicate
scaffold, no unauthorised dependency, one lockfile writer. All four reports were honest;
`pwa-screens` in particular reported two real defects against a file it was forbidden to
fix, which is exactly the behaviour the protocol is trying to produce.

The tree is green on typecheck, test and build, and red on lint for a reason that
predates the wave.

What the individual agents could not see, and this gate found: **the one component every
downstream lane depends on has a silent runtime failure on the sampler's id type, and no
test that could have caught it.** `<BoundaryMap>` typechecks, its helpers are well
tested, its prop API genuinely does serve both consumers — and tapping a point on the
Field screen would have done nothing, discovered somewhere in wave 2 or, worse, in a
field in October.
