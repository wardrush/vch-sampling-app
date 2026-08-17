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

## Wave 2 — GO. Consume wave 1, produce nothing each other needs

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
| 1 | **Glove/wind/low-sun palette hex values.** v02 §4.3 fixes the requirement and names no colour | **`spec-transcriber` + `map-surface`** | Two independent placeholder sets exist. Needs a design decision, not an agent. Binding is clean — `global.css` has zero colour values and the shell imports `SEMANTIC_COLORS` — so the swap stays cheap |
| 2 | Drift tolerance (seconds) for `CLOCK_DRIFT_SUSPECTED` | `defect-rules` | Rule unimplemented, correctly pending. Belongs in `REF.PROJECT_SAMPLING_SPEC` |
| 3 | Distance threshold (metres) for `EXIF_POSITION_MISMATCH` | `defect-rules` | Same. v02 §9 says "needs a distance threshold" without naming one |
| 4 | Long-press threshold + move tolerance | `map-surface` | 500 ms / 10 px used, from Android's `getLongPressTimeout()` default. Needs real-device confirmation |
| 5 | Service-worker update policy | `pwa-screens` | `registerType: 'prompt'` — never swap the app mid-form. Confirm if force-update is wanted |

**Escalation health:** no agent stopped twice for the same reason, so nothing was
mis-tiered. Both haiku agents stopped exactly where their specs ran out and neither
invented a threshold — FLEET.md §4 rule 6 working as designed.

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
