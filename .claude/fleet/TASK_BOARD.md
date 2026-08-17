# TASK_BOARD.md — live state of remaining work

*Task ids are `CONCURRENT_BUILD_PLAN_v01.md`'s. The **Agent** column is which
`.claude/agents/` definition to spawn; see `.claude/fleet/FLEET.md` §1–§3.*

**Compiled 2026-08-17** by reading the tree directly (file inventory under `src/`,
`netlify/functions/`, `PENDING_A8_RULES`) against `git log` — PRs #1–#4 are merged into
master. The "94 tests passing" figure is `SONNET_TASKS_STATUS.md`'s claim, **not
re-verified here**: this container has no `node_modules`, so the gate has never been run
against this checkout. Run `npm ci && npm run typecheck && npm test` before wave 1 and
correct this line with what you actually see.

Update this file in the orchestrator's per-wave commit — a stale board is how a task
gets built twice.

---

## Done — do not rebuild

`F0.1`–`F0.4`, `F0.5`, `F0.6`, `F0.7`, `F0.8`, `F0.9` (partial), `F0.10`, `F0.11` ·
`A1` `A2` `A3` `A4` `A5` `A6` `A7` `A10` `A11` `A13` · `B6` `B8` · `C7` `C8` `C11` `C12`

Full detail in `OPUS_TASKS_STATUS.md`, `SONNET_TASKS_STATUS.md`,
`HAIKU_TASKS_STATUS.md`. **Read those before assuming anything on this board is
untouched** — several "not started" items have real infrastructure sitting under them
already.

---

## Wave 1 — nothing blocks these, and everything else waits on them

| Task | Agent | Notes |
|---|---|---|
| **B1** · PWA shell, service worker, routing, OPFS + `wa-sqlite` bootstrap | `pwa-screens` | **There is no usable app yet.** `src/app/` holds two capture modules and nothing else — no route, no map, no screen. This is the largest gap between "done" and the deliverable. |
| **B3** · `<BoundaryMap>` — MapLibre + PMTiles wrapper | `map-surface` | The one cross-lane dependency in the build. Publish the prop API in the report before polishing. B5 and C10 both wait on it. |
| **A8** · Six defect rules | `defect-rules` | `PENDING_A8_RULES` in `src/server/defects/rules/index.ts` is the list. Harness + two reference rules already exist. |
| **B2** · Design primitives — 48 dp targets, glove/wind/low-sun palette, chips, badges | `spec-transcriber` | Pure transcription of v02 §4.3. |

## Wave 2 — consume wave 1, produce nothing each other needs

| Task | Agent | Notes |
|---|---|---|
| **B4** · Screen 1 Today | `pwa-screens` | "Yesterday's flags" is v1.5 — build the empty slot, not the feature. |
| **B5** · Screen 2 Field | `pwa-screens` | Hardest task in the lane. If it fights for more than half a day, re-spawn at `model: opus`. |
| **B7** · Barcode capture (ZXing, torch, manual entry beside it) | `pwa-screens` | Never normalise the barcode in place. DataWedge-injectable controlled input. |
| **B11** · Screen 5 Outbox | `pwa-screens` | A screen, not a spinner. Per-record failure reasons. |
| **C1–C4** · Paste parser, file parser, coordinate parsing, column mapping | `ingest-lane` | C4 is built against a guess until Thane's spreadsheet exists (pre-work item 2). |
| **C5** · `IMPORT_PROFILE` persistence | `ingest-lane` | Server-side, not a cookie. Auth exists. |
| **C6** · Client-side validation rules | `ingest-lane` | Each a pure function with a fixture. Swapped lat/lon fixes the whole file in one click. |
| **C9** · Preview table | `ingest-lane` | Commit enabled at zero blocked. |
| **A9** · Nightly scheduled + background pair | `server-endpoints` | **Not started.** `netlify.toml` declares `nightly-sweep-scheduled` pointing at a file that does not exist — it will 404 if deployed as-is. Scheduled function enumerates and kicks; it does no work (30 s ceiling). |
| **B9** · Condition chips, deviation picker, depth/cores exception | `spec-transcriber` | Thresholds all live in `PROJECT_SAMPLING_SPEC` and the code tables. |
| **B10** · Screen 4 Skip · **B12** · Screen 6 Storage | `spec-transcriber` | |

## Wave 3 — the joins

| Task | Agent | Notes |
|---|---|---|
| **C10** · Map preview panel | `ingest-lane` | Imports `<BoundaryMap>`. **Do not write a second MapLibre setup.** If B3 is not real yet, reorder to C13. |
| **C13** · Ingest tutorial branch | `ingest-lane` | The 12-row fault file, row by row, in spec §8. Sandbox commit is discarded. |
| **B14** · Sampler tutorial branch | `pwa-screens` | Skipping still sets `tutorial_completed_ts`. |
| **C14** · Analyst review queue | `server-endpoints` | Reads `CURATED.V_SAMPLE_REVIEW_QUEUE`, which already exists. **v02 R1: this is the first thing cut if the schedule slips.** |
| **B13** · PMTiles route-pack builder | `map-surface` | Measure a real fall assignment; do not ship the estimate as a promise. |

## Wave 4 — close out

| Task | Agent | Notes |
|---|---|---|
| **A12** · Deploy the DDL to `VCH_GEO` | `schema-steward` | **Blocked on the Snowflake service user + key pair + network policy.** `npx tsx tools/deploy-ddl.ts --dry-run` is the honest ceiling until then. |
| Three schema-name gaps | `schema-steward` | `boundaryIdsForCrew` (no `crew_org_id` assignment table), `loadAccessContacts` (no `CURATED.ACCESS_CONTACT`), `findOperationCandidates`/`findContactCandidates` (no `CURATED.OPERATION`/`PERSON`). Five functions total. Detail in `integration/requests-a.md`. **Do not re-guess these.** |
| **C15** · Redraw the ERD with v02 tables | `spec-transcriber` | `sampling_erd.mermaid` is v01 only. |
| **C16** · Acceptance criteria 8, 9, 10 | `ingest-lane` | ≥95% lab match, 300-row clipboard-to-committed under 30 s, swapped lat/lon in one click. All measurable now. |

---

## Not buildable in this environment — schedule, do not simulate

| Task | Why |
|---|---|
| **B15** · v02 §11 criteria **6** (90-second point timed in a field) and **7** (ten-hour day under 60% battery) | Real hardware, real ground. A test that claims to cover these is a false claim in the record. Criterion 11 (gallery photo cannot satisfy a required role) *is* buildable — `capture-integrity` owns it. |
| **A12** deploy, live-schema verification | Needs the Snowflake service user. |

---

## Blocking pre-work — none of it is engineering

Unchanged from plan v02 §10. Restated because ten agents make these more expensive to
leave open, not less — work queues behind each one.

1. **Snowflake service user + key-pair auth + network policy.** Three days to approve,
   five minutes to do. Blocks A12 and every live-warehouse path.
2. **Thane's actual current spreadsheet.** C4/C5's entire mapping layer is a guess
   without it.
3. **Real barcode labels from Agidata.** B7 is symbology-agnostic by design, so it does
   not block — but the crew cannot leave without a real label in hand.
4. **BCarbon confirmation on exception-based depth/core evidence.** One column in B9 if
   the answer is no, and far cheaper now than in week five.
5. **Fall window and crew size.** Sizes B13's route packs and the pilot.
