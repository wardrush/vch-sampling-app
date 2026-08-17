# TASK_BOARD.md — live state of remaining work

*Task ids are `CONCURRENT_BUILD_PLAN_v01.md`'s. The **Agent** column is which
`.claude/agents/` definition to spawn; see `.claude/fleet/FLEET.md` §1–§3.*

**Wave 1 complete, 2026-08-17.** Gate verified by `fleet-integrator` running alone and
re-verified by the orchestrator after the post-gate fix:

| Command | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm test` | **20 files · 166 passed · 1 skipped (167)** |
| `npm run build` | succeeds · precache 15 entries / 1384.26 KiB |
| `npm run lint` | **FAILS — see "Known-red" below. Pre-existing, not wave 1's doing** |

The old "94 tests passing" line is resolved: it was accurate when written, was verified
against this checkout at the start of wave 1, and has been superseded three times since.

Update this file in the orchestrator's per-wave commit — a stale board is how a task
gets built twice.

---

## Done — do not rebuild

`F0.1`–`F0.4`, `F0.5`, `F0.6`, `F0.7`, `F0.8`, `F0.9` (partial), `F0.10`, `F0.11` ·
`A1` `A2` `A3` `A4` `A5` `A6` `A7` `A10` `A11` `A13` · `B6` `B8` · `C7` `C8` `C11` `C12`

**Added by wave 1:** `B1` `B2` `B3` · `A8` (4 of 6 rules — see below)

Full detail in `OPUS_TASKS_STATUS.md`, `SONNET_TASKS_STATUS.md`,
`HAIKU_TASKS_STATUS.md`, and the five wave-1 reports in `.claude/fleet/reports/`.
**Read those before assuming anything on this board is untouched.**

---

## Wave 1 — COMPLETE

| Task | Agent | Landed |
|---|---|---|
| **B1** · PWA shell, service worker, routing, OPFS + `wa-sqlite` | `pwa-screens` | Router root, `AppShell`/`FocusShell` layouts, all six routes, real `wa-sqlite`+OPFS `SqlDatabase` via `bootstrapDeviceDb()`, `useDeviceDb()` hook, SW update banner. Four placeholder screens |
| **B2** · Design primitives | `spec-transcriber` | Button, Chip, Badge, Input, ConditionChip, DeviationChip + token set, all ≥48 dp. Chips render from the versioned code sets |
| **B3** · `<BoundaryMap>` | `map-surface` | MapLibre + PMTiles wrapper, offline-only style, bidirectional row↔pin hover, one GL instance per mount. Prop API published in its report and **confirmed to serve both consumers** |
| **A8** · Six defect rules | `defect-rules` | **4 of 6.** Two correctly left pending — see "Blocked on a decision" |

### The gate earned its keep

`fleet-integrator` found a **runtime blocker no individual agent could see**:
`<BoundaryMap>` silently dropped UUID feature ids, because MapLibre's GeoJSON→PBF
wrapper discards any `feature.id` that fails `!isNaN()`. Every sampler id is a UUIDv7,
so **tapping a planned point would never have opened Capture, and hover never
rendered** — while typecheck passed and 152 tests were green. C10 was unaffected
(numeric row ids), which is why the "serves both consumers" check missed it.

Fixed in-wave: `promoteId: 'id'` on both GeoJSON sources, plus `BoundaryMap.test.tsx`
(7 tests) — the component had **no test file at all**, which is what let it through.
The fail/pass split was verified by physically reverting the fix (4 of 7 fail without
it). **B5 is therefore unblocked.**

---

## Wave 3 — DONE 2026-08-17. **There is a shareable demo.** Gate: `npm run test:e2e` green

**The gate changed, and that is the headline.** `npm test` is no longer sufficient evidence for
anything touching browser storage. `npm run test:e2e` builds the production bundle, serves it
with `MOCK_SNOWFLAKE=1`, and drives the real flow in real Chromium at desktop **and Pixel 7**
viewports. 333 unit tests / 1 skipped still pass; they were never the problem.

### Why: three waves shipped a database driver that had never once executed

jsdom has no `navigator.storage`, no usable IndexedDB and no browser-like wasm host, so
`src/app/shell/db/**` could not run under `npm test` at all. It reached production unexecuted
and failed on the first real device with `unable to open database file`. **Two** separate bugs
were behind that message, and neither was findable without a browser:

1. **`OriginPrivateFileSystemVFS` calls `createSyncAccessHandle`, which is Worker-only**, and it
   was being called on the main thread → `SQLITE_CANTOPEN`. The driver's own header comment
   asserted the opposite; `grep -c createSyncAccessHandle` on the installed package says `1`.
   Now **`IDBBatchAtomicVFS`** — still durable (IndexedDB), main-thread, works on iOS Safari
   where OPFS is newer and thinner — with `MemoryAsyncVFS` as a last resort behind a
   non-dismissible banner, because a sampler must never believe a day's work is stored when it
   is not.
2. **The Asyncify build allows one call in flight per connection.** `Promise.all([...])` in
   `TodayScreen` corrupted the VFS and reproduced *the identical error message* on reload once
   the database held data — 100% reproducible. Fixed with a FIFO queue inside the one file that
   knows wa-sqlite exists, rather than auditing every call site.

Had only the first fix landed, the app would have worked once and failed on reload.

### The demo

`/tutorial` — four steps (Today, Field, Capture, Outbox), each labelled **"demo data only"**,
skippable, with a permanent "Show me again ↺". The Capture step drives
`capture-integrity`'s real `TutorialCaptureSession`, so it shows the actual GPS averaging and
photo pipeline. Walkthrough in `.claude/fleet/reports/pwa-screens-wave3.md`.

### The map was blank, and the suite passed anyway

`FocusShell`'s root used **`minHeight: '100%'` instead of `height: '100%'`**. `min-height` is a
lower bound on a content-sized box; it gives descendants nothing definite to resolve `height:
100%` against, so `<BoundaryMap>`'s container computed to 0 and clipped a correctly-initialised
412×300 canvas. Upstream of `<BoundaryMap>`, so `map-surface`'s file was never touched.

The E2E suite passed while the map was invisible — it was not yet testing what the demo most
depends on. It now asserts container height, viewport-fill ratio, zero gap to the point strip,
and **samples real screenshot pixels** (via a hand-rolled PNG decoder over `node:zlib`, since
`<BoundaryMap>` does not set `preserveDrawingBuffer`) to prove the polygon is actually painted.
**Verified by reverting the fix and confirming the suite goes red**, then restoring it — twice.

### A false-positive trap worth remembering

The agent's first "green" was a **stale `vite preview` on port 4173**, silently reused by
`webServer.reuseExistingServer`. It was caught only because a deliberate revert was *expected*
to go red and came back green. Kill stale preview servers before trusting an E2E result.

---

## Wave 2 — DONE 2026-08-17. Gate: typecheck clean, 31 files / 300 passed / 1 skipped

**There is a demonstrable flow now.** Screens went from 84 lines of placeholder to ~2,200
lines. `B4` `B5` `B7` `B11` (`pwa-screens`) · `B9` `B10` `B12` (`spec-transcriber`) ·
capture path (`capture-integrity`) · `assignments-bundle` ported to `SqlClient`
(`server-endpoints`).

**Demo:** `MOCK_SNOWFLAKE=1` → Today → Field (6 points on a real `<BoundaryMap>`) →
Capture (live `getUserMedia` photo, barcode, chips) → Outbox. Full walkthrough in
`.claude/fleet/reports/pwa-screens-wave2.md`.

### Criterion 11 is met, and enforced rather than asserted

A gallery photo cannot satisfy a required role — four layers, three CI-enforced: the type
(`addGalleryPhoto` takes `OptionalMediaRole`; widening it fails typecheck), a guard that
refuses *before* `file.arrayBuffer()` is called, `capture_source: 'in_app_camera'` minted
in exactly one place tree-wide with a source scan asserting it, and a record-level test.
Each was verified to fail when removed.

### Integrity defects found across lane boundaries

`capture-integrity` audited `pwa-screens`' code and found two real ones, both closed:

1. **EXIF timestamps were unrecoverably wrong.** `.toISOString()` on `exifr`'s revived
   zoneless `DateTimeOriginal` treats it as local, so a US/Central phone stored
   `2026-10-02T20:00:00Z` for a **15:00** photograph. The zone was invented, the original
   lost.
2. **`getPhotoStore()` silently fell back to in-memory** — until upload those bytes are
   the only copy of the evidence.

Also fixed: `manualPinCapture` wrote `gps_accuracy_m: 0` for a dropped pin. Zero reads as
a *perfect* measurement in 2029; now `null`.

### Accepted trade-off, stated rather than hidden

Required-role photos are **`getUserMedia` only, with no `<input capture>` fallback** — on
desktop that element is just a file picker, and the schema has no value meaning "we asked
for a camera and got a file browser". A `getUserMedia` frame carries **no EXIF**, so
`EXIF_POSITION_MISMATCH` has nothing to compare on required photos. Nothing was destroyed;
there was never anything there. It returns with the Capacitor native camera.

### Known gaps, named not invented

No dev-time proxy from `vite` to Netlify functions, so under plain `npm run dev` the
bundle fetch falls back to the fixture and Outbox sync **reports failure honestly** — use
`netlify dev` or a deploy for the real sync path. `local_status` is not preserved across a
second bundle re-apply; one `field_visit` per boundary; multi-spec-per-boundary unwired;
no photo-removal UI.

### Protocol note

`spec-transcriber` wrote `src/app/App.tsx`, which is **`pwa-screens`'** (§4 rule 2), while
`pwa-screens` was concurrently writing it. Verified at the gate: `pwa-screens`' version won
and wires all six screens including `spec-transcriber`'s two, so nothing was lost — but
that was luck, not the protocol working.

---

## Wave 2 (original plan) — superseded by the above

| Task | Agent | Notes |
|---|---|---|
| **B4** · Screen 1 Today | `pwa-screens` | "Yesterday's flags" is v1.5 — build the empty slot, not the feature |
| **B5** · Screen 2 Field | `pwa-screens` | **Unblocked** — the `promoteId` fix landed. Code against the prop API in `map-surface`'s report; it did not change. Hardest task in the lane; if it fights for more than half a day, re-spawn at `model: opus` |
| **B7** · Barcode capture | `pwa-screens` | Never normalise the barcode in place. DataWedge-injectable controlled input |
| **B11** · Screen 5 Outbox | `pwa-screens` | A screen, not a spinner. Per-record failure reasons |
| **C1–C4** · Paste/file parser, coordinates, column mapping | `ingest-lane` | C4 is a guess until Thane's spreadsheet exists (pre-work 2). **This is where the haiku bet gets settled** — if C1–C6 come back needing rework rather than review, move the lane to sonnet wholesale |
| **C5** · `IMPORT_PROFILE` persistence | `ingest-lane` | Server-side, not a cookie |
| **C6** · Client-side validation rules | `ingest-lane` | Each a pure function with a fixture. Swapped lat/lon fixes the file in one click |
| **C9** · Preview table | `ingest-lane` | Commit enabled at zero blocked |
| **A9** · Nightly scheduled + background pair | `server-endpoints` | **Not started.** `netlify.toml` declares `nightly-sweep-scheduled` pointing at a file that does not exist — it will 404 if deployed as-is. Scheduled function enumerates and kicks; it does no work (30 s ceiling) |
| **B9** · Condition chips, deviation picker, depth/cores exception | `spec-transcriber` | Thresholds live in `PROJECT_SAMPLING_SPEC` and the code tables |
| **B10** · Screen 4 Skip · **B12** · Screen 6 Storage | `spec-transcriber` | `App.tsx` currently renders inline placeholders at these routes, each naming B10/B12 as owner. Wire the real imports when they land |

### Wave 2 must also pick up, from the gate

| Task | Agent | Why |
|---|---|---|
| **Registry test that was claimed but never written** | `sync-spine` | `src/server/defects/rules/index.ts:13` states `rules.registry.test.ts` "asserts that every code is either implemented or listed pending, so a rule cannot go missing quietly." **That file has never existed.** It is a false claim of a safety net in the code record |
| **Three orphaned defect codes** | `sync-spine`, then `defect-rules` | `BARCODE_UNREAD`, `LATE_SYNC`, `MANUAL_POSITION` are in the code table, raised by nothing anywhere, and listed pending by nothing. Exactly the "discovered in April" failure the comment above promised was impossible |
| **One manual OPFS pass on real Chrome / Android WebView** | human, not an agent | The migration orchestration is tested against real SQLite, but **the OPFS driver itself is unexecuted** — jsdom has no `navigator.storage`. B4/B11 build on it. Do this before, not after |

---

## Wave 3 — the joins

| Task | Agent | Notes |
|---|---|---|
| **C10** · Map preview panel | `ingest-lane` | Imports `<BoundaryMap>`. **Do not write a second MapLibre setup.** B3 is real, not a stub |
| **C13** · Ingest tutorial branch | `ingest-lane` | The 12-row fault file, row by row, spec §8. Sandbox commit is discarded |
| **B14** · Sampler tutorial branch | `pwa-screens` | Skipping still sets `tutorial_completed_ts` |
| **C14** · Analyst review queue | `server-endpoints` | Reads `CURATED.V_SAMPLE_REVIEW_QUEUE`, which exists. **v02 R1: first thing cut if the schedule slips** |
| **B13** · PMTiles route-pack builder | `map-surface` | Measure a real fall assignment; do not ship the estimate as a promise. Needs pre-work 5 |

## Netlify DB backend (MVP/UAT) — steward pass done 2026-08-17

**Decision:** MVP/UAT storage is a Netlify database (Neon Postgres); Snowflake stays a
first-class backend behind `SQL_BACKEND`. Reason is schedule, and it is the user's call
— pre-work item 1 (Snowflake service user) is a three-day approval and testers reacting
to a running system beats waiting for the perfect warehouse. **Geospatial is deferred
(no PostGIS); scope is sync/derive + ingest only**; auth and the analyst queue keep
serving fixtures.

Landed: the `SqlClient` port (`src/shared/db/port.ts`), the Neon adapter, 990 lines of
Snowflake DDL translated to `postgres_sampling_v01.sql`, `SQL_BACKEND` wiring in
`env.ts`, and an idempotent 77-statement migration runner behind a
`pg_advisory_xact_lock` wired into the Netlify build. Additive throughout — all 24
existing Snowflake importers compile untouched.

**Geospatial absence is structurally enforced, not documented.** A CHECK constraint
makes `REVIEW_STATE = 'screened'` impossible without a real geo derivation, so the
Postgres path cannot record a pass it did not perform; the clean state is
`screened_partial` and `V_SAMPLE_GEO_ASSURANCE.ASSURANCE_VERDICT` reads
`clean_geo_unverified`. **`boundary_id` is nullable with no sentinel — decided**, because
"checked, outside all boundaries" is a finding and "never checked" is not, and one
sentinel cannot encode both.

### Wave B — DONE 2026-08-17. Gate: typecheck clean, 23 files / 254 passed / 1 skipped

| Task | Agent | Outcome |
|---|---|---|
| **N1** · `isMockMode()` keyed off the backend | `server-endpoints` | Done. Verified across six env permutations under `env -i`. `MOCK_SNOWFLAKE=1` and the bare-checkout default both still resolve to mock |
| **N2** · Port `src/server/{sync,derive}/**` | `sync-spine` | Done. `/sync/batch` complete on Postgres, driven through the real `PostgresClient` rather than a fake. Snowflake output **byte-identical for 4 of 6 mappings**; the two that differ are the bug fixes below |
| **N3** · Port `src/ingest/**` | `ingest-lane` (escalated to sonnet) | Done. **No `ST_*` call had a caller in the lane** — the steward's suspicion confirmed, so the dialect work was smaller than the raw counts implied |

**Geometry matching is out of the MVP** per the user, gated on `capabilities.geospatial` — no new flag, so Snowflake keeps full behaviour and regains the feature automatically. Ingest distinguishes three non-blocking states: no capability, capable-but-empty-cache, and genuinely unplaceable.

### Three latent bugs the port exposed — none of them Postgres-specific

All three would have failed on **Snowflake too**. This is the strongest argument that the dual-backend parity check earns its keep.

1. **`/sync/batch` bound the batch id and the payload backwards.** `SYNC_BATCH_ID` received a JSON array and `PARSE_JSON` received a batch id, so **every entity write would have failed on either backend.** Fixed by returning SQL and binds together so a caller cannot transpose them.
2. **`CURATED.SAMPLE_CONDITION` was stamped `LAST_UPDATED_TS`/`LAST_UPDATED_BY`** — columns present in neither DDL.
3. **`CURATED.SAMPLE_DEFECT` was stamped `SYNC_BATCH_ID`** — no such column, so device-raised `local_defect` records **have never been writable**. Worked around; whether the column should exist is `schema-steward`'s call.

Also fixed: the rebuild path aggregated all RAW records into one unordered array, so a corrected sample could rebuild from the *older* payload. A non-deterministic rebuild does not satisfy criterion 5.

### Still blocking a usable MVP — pass 3

| # | Item | Owner | Why it blocks |
|---|---|---|---|
| 1 | **`src/server/defects/harness.ts` is Snowflake-only** — emits `PARSE_JSON`+`FLATTEN`+`MERGE`, typed `SnowflakeClient` | **unowned in FLEET.md §1** | **No defect detection on Postgres.** The pipeline skips steps 7 *and* 8 loudly, so rows stay `captured`/`awaiting_derivation` rather than being marked clean by a screening that never ran. Exact patch in `requests-a.md` |
| 2 | **`assignments-bundle.ts` calls `snowflake()` directly**, typed `SnowflakeClient` all the way down | `server-endpoints` | Now reachable under Postgres after N1, so it **throws `missing SNOWFLAKE_ACCOUNT`**. The sampler cannot fetch what to sample — ingest can write plan points but the device cannot read them |
| 3 | `src/shared/auth/**` is **unowned** | needs assigning | `AuditWriterOptions.snowflake` needs widening to `SqlClient`. Not urgent — auth is deliberately out of scope and ingest writes `AUDIT_EVENT` through its own statements |
| 4 | **`CURATED.BOUNDARY_CACHE` has no loader** | parked | **No longer blocking** — an empty cache is now harmless. Still needs real `VCH_GEO` names before geometry matching returns |

### Protocol note

`ingest-lane` ran `git checkout -- tests/support/fake-snowflake.ts`, a forbidden write git command (§4 rule 1), and **self-disclosed it at the top of its report**. Checked: the file matches `HEAD` and `sync-spine` used its own `tests/acceptance/support/fake-sql-client.ts`, so nothing was lost. Had both lanes been in that file, it would have destroyed the other's work — which is exactly why the rule exists.

### Real drift found, not fixed

The Snowflake seeds carry `OFFSET_WITHOUT_REASON` but the code raises
`OFFSET_EXCEEDED_NO_REASON`, and `GEOM_INVALID` is seeded nowhere — the bootstrap's
own check cannot detect either. The Postgres seeds all 17 codes from
`src/shared/codes/index.ts` and assert completeness at deploy time. **The Snowflake
files were deliberately not edited** — that is a separate, human-reviewed change.

---

## Wave 4 — close out

| Task | Agent | Notes |
|---|---|---|
| **A12** · Deploy the DDL to `VCH_GEO` | `schema-steward` | **Blocked on the Snowflake service user + key pair + network policy.** `npx tsx tools/deploy-ddl.ts --dry-run` is the honest ceiling until then |
| Three schema-name gaps | `schema-steward` | `boundaryIdsForCrew`, `loadAccessContacts`, `findOperationCandidates`/`findContactCandidates`. Detail in `integration/requests-a.md`. **Do not re-guess these** |
| **C15** · Redraw the ERD with v02 tables | `spec-transcriber` | `sampling_erd.mermaid` is v01 only |
| **C16** · Acceptance criteria 8, 9, 10 | `ingest-lane` | ≥95% lab match, 300-row clipboard-to-committed under 30 s, swapped lat/lon in one click |

---

## Known-red, and it is not a wave's fault

**`npm run lint` has never executed a single rule on this repository.** `package.json`
pins `eslint ^9.11.1` (9.39.5 installed) against a `.eslintrc.cjs` — the pre-flat format
ESLint 9 dropped. Last touched in `46c38d8`, before wave 1.

Consequence, stated plainly: **every "green gate" in this repo's history is typecheck +
test only**, and the `eslint-disable` comments in the tree have never suppressed
anything real. Fix is to migrate to `eslint.config.js` (flat) or pin `eslint@^8` — both
orchestrator-owned. **Deliberately not done in the wave-1 commit**: it will surface an
unknown quantity of pre-existing lint debt, and that belongs in its own commit rather
than muddying a wave. Schedule it before wave 3.

---

## Blocked on a decision, not on engineering

Deduplicated across all five wave-1 reports. **Item 1 was hit by two independent
agents, which makes it the strongest signal on this board.**

| # | Unspecified | Raised by | Consequence today |
|---|---|---|---|
| 1 | ~~**Glove/wind/low-sun palette hex values**~~ — **RESOLVED 2026-08-17.** Taken from the company's live site: sand / moss / gold, with Quicksand and the VCH logo. See "Brand pass" below | ~~`spec-transcriber` + `map-surface`~~ | Closed. The clean binding predicted here paid off — the swap touched one token file plus the map's own constants |
| 2 | Drift tolerance (seconds) for `CLOCK_DRIFT_SUSPECTED` | `defect-rules` | Rule unimplemented, correctly pending. Belongs in `REF.PROJECT_SAMPLING_SPEC` |
| 3 | Distance threshold (metres) for `EXIF_POSITION_MISMATCH` | `defect-rules` | Same. v02 §9 says "needs a distance threshold" without naming one |
| 4 | Long-press threshold + move tolerance | `map-surface` | 500 ms / 10 px used, from Android's `getLongPressTimeout()` default. Needs real-device confirmation |
| 5 | Service-worker update policy | `pwa-screens` | `registerType: 'prompt'` — never swap the app mid-form. Confirm if force-update is wanted |

**Escalation health:** no agent stopped twice for the same reason, so nothing was
mis-tiered. Both haiku agents stopped exactly where their specs ran out and neither
invented a threshold — FLEET.md §4 rule 6 working as designed.

---

## Brand pass — 2026-08-17

The identity now comes from Veteran's Carbon Holdings' own site: three named scales
(**sand** grounds/text, **moss** actions, **gold** accent), **Quicksand** 400/600/700
self-hosted, and the VCH logo as the icon set. Precache went 15 → 25 entries as fonts
and icons joined the wasm binary, so the app keeps its typeface offline.

**Roles were assigned from measured WCAG contrast, not copied from the website.** The
site's own gold usage does not survive this app's conditions — `text-gold-700` on the
sand ground is 3.44:1 and white on `bg-gold-700` is 3.81:1, both below AA. Gold is
therefore accent/border/large-text only; moss carries actions (8.73:1); sand carries
body text (13.88:1). The brand values are unchanged — only which role each fills.

### Still open after the pass

| # | Item | Owner | Why it matters |
|---|---|---|---|
| 1 | **The brand has no red.** The site ships Tailwind's red scale but never uses it. A functional red is in place for blocking defects, commented as functional-not-brand | design review, then `spec-transcriber` | A field app must show a blocking defect unmistakably. Confirm this red or supply an official one |
| 2 | **`FONT_SIZES.base` is 14 px** in `components/tokens/index.ts` while the shell body is now 17 px | `spec-transcriber` (wave 2) | Raised by `pwa-screens` across a path boundary. Quicksand has a low x-height and this is read at arm's length in gloves and low sun. Two different base sizes is also drift waiting to happen |
| 3 | **Gold does double duty on the map** — `gold-500` for the unrecognised-status pin, `gold-700` for the boundary stroke | `map-surface` | Distinguishable by shade and shape, but it is the one place the brand's "contrasts against green/brown aerial imagery" set is effectively just gold. Ingest's `flagged` fixture is already an amber |
| 4 | **Moss and sand are the colours of the ground the imagery shows** | `map-surface` | Boundary fills are a 12% wash so blending is acceptable; strokes and pins got legibility treatment instead. Confirm on a real device over real imagery |

---

## Not buildable in this environment — schedule, do not simulate

| Task | Why |
|---|---|
| **B15** · v02 §11 criteria **6** (90-second point timed in a field) and **7** (ten-hour day under 60% battery) | Real hardware, real ground. The gate confirmed **no test falsely claims these** — that discipline held. Criterion 11 (gallery photo cannot satisfy a required role) *is* buildable — `capture-integrity` owns it |
| **A12** deploy, live-schema verification | Needs the Snowflake service user |

---

## Blocking pre-work — none of it is engineering

Unchanged from plan v02 §10. Ten agents make these more expensive to leave open, not
less — work queues behind each one.

1. **Snowflake service user + key-pair auth + network policy.** Three days to approve,
   five minutes to do. Blocks A12 and every live-warehouse path. Per FLEET.md §3 this
   call should have been made before wave 1; **wave 4 depends on it entirely.**
2. **Thane's actual current spreadsheet.** C4/C5's mapping layer is a guess without it,
   and wave 2 is where that guess gets built.
3. **Real barcode labels from Agidata.** B7 is symbology-agnostic by design, so it does
   not block — but the crew cannot leave without a real label in hand.
4. **BCarbon confirmation on exception-based depth/core evidence.** One column in B9 if
   the answer is no. B9 is wave 2, so this is now due.
5. **Fall window and crew size.** Sizes B13's route packs and the pilot.
