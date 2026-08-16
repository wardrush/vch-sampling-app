# Concurrent Build Plan — v01

*2026-08-16 · Viridi Data · how to build `SAMPLING_APP_PLAN_v02.md` §10 with three Claude Code instances running at once*
*Companion to, not a replacement for, plan v02. Every scope decision below comes from v02, the ingest spec, the sync contract and the v02 addendum. What this document adds is the **cut** — which work goes to which instance, at which model, touching which files.*

---

## 0. The one-paragraph version

Plan v02 phases the build as two engineers over six sequential weeks. Three concurrent Claude Code instances change the shape of that but not its length: parallelism compresses weeks 3–5 and does nothing for weeks 1–2, because the contract has to exist before anything can be built against it. So the cut is **one half-day of foundation work by a single Opus instance, then three lanes that never touch the same file**, integrating daily. Lanes are ownership boundaries, not model assignments — each lane has a default model and a per-task tag, and the instance switches with `/model` when it hits a task tagged differently. The seam that makes this work is the one the documents already have: typed contracts plus fixtures, so Lane B and Lane C never wait on a Snowflake connection or on Lane A's functions being real.

**The six weeks do not become two.** Use the slack the parallelism buys on the two things v02 currently squeezes into week 6: the field trial on real ground, and the battery and storage measurement.

---

## 1. The three lanes

| Lane | Owns | Default model | Why that model |
|---|---|---|---|
| **A — Sync spine & server** | The outbox worker, all Netlify functions, the derivation pipeline, Snowflake access, auth, DDL | **Opus 5** | v02 Appendix A names exactly these: idempotency, ordering, partial-ack, the pipeline, schema. "Plausible but subtly wrong" here loses a season |
| **B — Sampler PWA** | The six screens, map, capture, camera, barcode, tile packs | **Sonnet 5** | The bulk. Screens of forms and one map, against a written spec, with a human looking at the result on a phone |
| **C — Ingest tool, then analyst queue** | Parse, mapping, validation, preview, commit, tutorial; then the review queue | **Haiku 4.5** | The most spec-complete work in the build — `PLAN_INGEST_SPEC_v01.md` is close to a transcription target. Escalates to Sonnet/Opus on four named tasks |

Lane C is the one that proves or disproves v02 Appendix A's claim that Haiku is real savings *because these documents exist*. It is also the lane that can fail cheapest, which is the right place to test that claim.

### Model tags used below

**[OPUS]** · **[SONNET]** · **[HAIKU]** — the tag is per task, not per lane. When an instance reaches a task tagged above its default, it runs `/model opus` (or `sonnet`), does that task, and switches back. Every escalation below is named and justified; there are seven of them in total.

---

## 2. F0 — Foundation. One Opus instance, alone, before anyone else starts

**Half a day. Nothing else runs concurrently with this.** Its entire purpose is to create every file that two lanes might otherwise both create, so that from that commit onward no two lanes need to touch the same path.

| # | Task | Model | Output |
|---|---|---|---|
| F0.1 | Repo scaffold: Vite + React + TS, Vitest, ESLint/Prettier, tsconfig path aliases | **[SONNET]** | `package.json`, `vite.config.ts`, `tsconfig.json` |
| F0.2 | `netlify.toml` with **every** function and redirect pre-declared, including ones not yet written | **[SONNET]** | Nobody edits this file again. That is the point |
| F0.3 | Install **the full dependency set at once**: `maplibre-gl`, `pmtiles`, `wa-sqlite`, `@zxing/browser`, `xlsx`, `exifr`, `@netlify/blobs`, `jose`, `uuidv7` | **[SONNET]** | One lockfile write. See §5 rule 2 |
| F0.4 | `src/shared/contract/*.ts` — TS types for the whole wire surface: bundle response, sync batch req/resp, media ticket, defect feed, ingest validate/commit/retire | **[OPUS]** | Transcribed from `SYNC_CONTRACT_v01.md` §2–§4 and addendum §4.3. **This is the seam the three lanes meet at** |
| F0.5 | `src/shared/codes/*.ts` — defect codes, condition codes, deviation reasons, validation codes, entity priorities from contract §5 | **[HAIKU]** | Pure transcription from the DDL and addendum §4.2 |
| F0.6 | `src/shared/db/schema.ts` — device SQLite bootstrap from `device_sqlite_v01.sql` + `_v02_addendum.sql`, with a migration runner | **[OPUS]** | Both lanes B and C read local state through this |
| F0.7 | **Fixtures.** `fixtures/bundle.f26-demo.json` (one boundary, six plan points, one with an unreadable barcode), `fixtures/plan_import_12row.tsv` (the exact fault set in ingest spec §8), `fixtures/sync_batch/*.json`, `fixtures/defect_feed.json` | **[HAIKU]** | **The reason B and C never block on A.** Every fixture is also a v02 §11 acceptance-test input |
| F0.8 | **Mock function server** — `netlify dev` handlers that serve the fixtures for every endpoint in `netlify.toml` | **[SONNET]** | B and C develop against this all six weeks and never need Snowflake credentials |
| F0.9 | **Stub every module each lane owns** — correct export signature, `throw new Error('not implemented')` | **[SONNET]** | So no lane ever *creates* a file another lane *imports*. Biggest single collision source, removed up front |
| F0.10 | `CLAUDE.md` ownership table (§4 of this doc) + `CODEOWNERS` + the three lane briefs in `lanes/` | **[HAIKU]** | |
| F0.11 | Flatten the doc-path discrepancy: `claude.md`'s table says `docs/` and `ddl/`; the files are at root. Move them or fix the table — one or the other, today | **[HAIKU]** | Three instances about to read these paths is the wrong time to have them wrong |

**Gate:** `npm run typecheck` passes, `netlify dev` serves every fixture, all three lane briefs exist. Commit, push, *then* open the other two instances.

---

## 3. The lanes in detail

### Lane A — Sync spine and server · default **Opus 5**

Runs weeks 1–6. Everything here is either load-bearing under v02 Appendix A's definition, or security.

| # | Task | Model | Depends on | Notes |
|---|---|---|---|---|
| A1 | **Snowflake SQL API v2 client**, key-pair JWT auth, stateless | **[OPUS]** | F0 | Addendum §4.4. Crypto and cold-start behaviour. **Deliver by end of day 1** — Lane C's server-side validation imports it |
| A2 | `/assignments/bundle` — bundle generation, ETag, `expires_ts`, `crew_org_id` scoping, `server_time` | **[SONNET]** | A1 | Contract §2. Replace-never-patch. Output must match `fixtures/bundle.f26-demo.json` byte-shape |
| A3 | **The outbox worker** — priority ordering, `depends_on`, blind-retry idempotency, jittered backoff (5s/30s/2m/10m/1h), partial-ack, `retryable` handling, resume after force-quit | **[OPUS]** | F0 | Contract §1, §3, §5. ~600 lines. The single most consequential file in the build; v02 Appendix A names it first |
| A4 | `/sync/batch` — verbatim RAW persist + content hash, then `MERGE` on client keys, per-record accept/reject, never whole-batch reject | **[OPUS]** | A1, A3 | Contract §3, §6 steps 1–2 |
| A5 | **Media tickets** — `already_have` on hash, Netlify Blobs PUT through the function, `/sync/media/commit` with hash verification | **[OPUS]** | A4 | Contract §4, addendum §4.1. Keep the URL-in-a-ticket seam intact — the S3/R2 swap is v1.5 and must stay a server-side change |
| A6 | **Derivation pipeline** as a background function — `TRY_TO_GEOGRAPHY`, PIP → `boundary_id`, TRS, offset/bearing from plan, review state | **[OPUS]** | A4 | Contract §6 steps 3–6, 8. Payload is a `sync_batch_id`, never data (256 KB cap) |
| A7 | **Defect rule harness** — the runner, idempotency per `sync_batch_id`, `visible_to_field` from `REF.DEFECT_FIELD_VISIBILITY` | **[OPUS]** | A6 | Contract §6 step 7 |
| A8 | **The individual defect rules** — duplicate barcode, missing required media role, offset-exceeded-without-reason, clock drift, EXIF-vs-GPS mismatch, gallery-sourced media, depth shortfall | **[HAIKU]** | A7 | Each is a pure function with a fixture. Exactly the shape v02 Appendix A puts in the cheap tier — *once the harness exists* |
| A9 | **Nightly scheduled function** — enumerates and kicks background functions; does no work itself | **[SONNET]** | A6 | 30 s ceiling. Unsampled-point sweep and plan close run in the background function it kicks |
| A10 | **Token auth** — `/ingest/<token>` and device enrolment → validate against `INGEST_ACCESS_TOKEN`, signed httpOnly session cookie, `imported_by` stamping | **[OPUS]** | A1 | Plan §8, ingest spec §9. Security-bearing, and the shape decides whether the IdP swap is a swap or a rewrite. **Deliver by end of week 1** — Lane C's tutorial gate needs the session |
| A11 | **`AUDIT_EVENT` writer** + the offline session / `offline_valid_until` device path | **[OPUS]** | A10 | Addendum §2.6, contract §7 |
| A12 | **Deploy the DDL** to `VCH_GEO`: `snowflake_sampling_v01.sql` then `snowflake_v02_addendum.sql`. Fix the `V_IMPORT_PREVIEW` `CURATED.BOUNDARY`/`PROPERTY`/`LAB_RESULT` references against live `FACT_BORDER` naming | **[OPUS]** | Pre-work item 5 | Schema decision, flagged in a comment in the DDL already. **Blocked on the Snowflake service user — three days to approve, five minutes to do. Make that call before opening any instance** |
| A13 | Acceptance tests v02 §11 items **1, 2, 3, 4, 5** — seven-day airplane-mode drain, force-quit ×20, defect-in-a-minute, replay idempotency, CURATED rebuilt from RAW | **[OPUS]** | A3–A8 | These five are the ones that fail quietly. Owned by the lane that wrote the code they test |

**Out of Lane A's v1 scope, per v02:** defect down-sync endpoint (`/v1/defects/open`, v1.5), S3/R2 swap, real IdP.

---

### Lane B — Sampler PWA · default **Sonnet 5**

Runs weeks 1–6. Develops entirely against the F0.8 mock server and F0.7 fixtures; needs nothing from Lane A until integration week.

| # | Task | Model | Depends on | Notes |
|---|---|---|---|---|
| B1 | PWA shell, service worker, install prompt, routing, OPFS + `wa-sqlite` bootstrap | **[SONNET]** | F0.6 | |
| B2 | **Design primitives** — 48 dp minimum targets, glove/wind/low-sun palette, form components, chips, badges | **[HAIKU]** | B1 | Plan §4.3. Pure spec transcription; the constraint is written down |
| B3 | **`src/shared/map/`** — MapLibre + PMTiles wrapper, `<BoundaryMap>` with boundary polygons, status-coloured pins, hover-highlight | **[SONNET]** | B1 | **Lane B owns this and Lane C consumes it. Publish the prop API and ship a working component by end of day 3.** The one cross-lane dependency in the build — see §5 rule 5 |
| B4 | **Screen 1 · Today** — route-sorted boundaries, progress rings, acres, tap-to-call, outbox count, bundle expiry. "Yesterday's flags" behind a feature flag, off in v1 | **[SONNET]** | B3 | v02 §2. The flags panel is v1.5; build the empty slot, not the feature |
| B5 | **Screen 2 · Field** — polygon on cached basemap, plan points by state, live position + accuracy ring, long-press to add a field point | **[SONNET]** | B3 | The hardest task in the lane. If it fights for more than half a day, `/model opus` |
| B6 | **Screen 3 · Capture — GPS** — acquire on screen open not on submit, several fixes averaged, spread recorded, live accuracy against spec threshold, `position_source` | **[OPUS]** | B5 | *Escalated.* Fix averaging, spread and the satellite-fix-vs-dropped-pin distinction are audit-bearing (plan §9) and are read in 2029. Small file, big consequence |
| B7 | **Screen 3 · Capture — barcode** — ZXing via `getUserMedia`, torch, manual entry always beside it, `barcode_capture_method`, DataWedge-injectable controlled input | **[SONNET]** | B2 | Plan §4.3. Never normalise the barcode in place |
| B8 | **Screen 3 · Capture — camera** — three role tiles, downscale to 1920 px long edge at q≈0.72, sha256, EXIF lat/lon/ts preserved verbatim + `EXIF_RAW`, `capture_source` enforcement | **[OPUS]** | B2 | *Escalated.* v02 §9 calls `capture_source` the single most important audit distinction in the media table; required roles must be **structurally** incapable of accepting a gallery photo, not validated after the fact |
| B9 | **Screen 3 · Capture — the rest** — condition chips from the versioned code set, deviation reason picker on the block threshold, depth/cores behind "different from spec?" | **[HAIKU]** | B2, F0.5 | Reference data and thresholds are all in `PROJECT_SAMPLING_SPEC` and the code tables. Nothing to decide |
| B10 | **Screen 4 · Skip** — reason code, optional photo, optional note | **[HAIKU]** | B9 | |
| B11 | **Screen 5 · Outbox** — pending records, pending photo MB, last sync, manual sync, per-record failure reasons | **[SONNET]** | A3 contract types only | A screen, not a spinner — v02 §2 is explicit about why |
| B12 | **Screen 6 · Storage** — used, free, reclaim uploaded photos | **[HAIKU]** | B1 | |
| B13 | **PMTiles route-pack builder** — z12–z17, 500 m buffer, content-hashed, resumable fetch | **[SONNET]** | — | v02 §4.4 has the tile arithmetic. Measure a real fall assignment; do not ship the estimate as a promise |
| B14 | **Sampler tutorial branch** — demo boundary, six fake points, one deliberately unreadable barcode, sets `tutorial_completed_ts` server-side | **[HAIKU]** | B4–B9, A10 | v02 §4.5. Skipping still sets the flag |
| B15 | Acceptance tests v02 §11 items **6, 7, 11** — 90-second point timed in a field, ten-hour day under 60% battery, gallery photo cannot satisfy a required role | **[SONNET]** | B4–B9 | 6 and 7 need real hardware and a real field. Schedule them, don't simulate them |

---

### Lane C — Ingest tool, then analyst queue · default **Haiku 4.5**

Weeks 1–3 ingest (v02 gives it one week on top of infrastructure; three at Haiku's pace with escalations is honest and still finishes early), weeks 4–5 analyst queue, week 6 integration support.

| # | Task | Model | Depends on | Notes |
|---|---|---|---|---|
| C1 | **Clipboard paste parser** — tab-separated, header row optional, Excel/Sheets block | **[HAIKU]** | F0 | Ingest spec §2 |
| C2 | **File parser** — CSV, TSV, XLSX via SheetJS client-side, sheet picker when >1 | **[HAIKU]** | C1 | Spec §10: the workbook never reaches a function |
| C3 | **Coordinate parsing** — decimal degrees, DMS, `47°54'12.3"N`, original preserved in `lat_raw`/`lon_raw`, `coord_format_detected` | **[HAIKU]** | — | Spec §3. Fully specified; a fixture table settles it |
| C4 | **Column mapping** — synonym table, header guess, chips UI with dropdown override, no-header positional fallback | **[HAIKU]** | C2 | Spec §4 |
| C5 | **`IMPORT_PROFILE` persistence** — saved mapping per user, second upload zero-click, expand-and-explain on mismatch | **[HAIKU]** | C4, A10 | Addendum §2.4. Server-side, not a cookie |
| C6 | **Client-side validation rules** — missing required, coordinate range, **swapped lat/lon with one-click swap-all**, in-file duplicate label, unmapped-column advisory | **[HAIKU]** | C3 | Spec §5. Each rule a pure function with a fixture |
| C7 | **`/ingest/validate` function** — PIP against active boundaries, duplicates against released plans, implausible-distance check | **[SONNET]** | A1 | Addendum §4.3. Stateless, idempotent, no writes; 5,000 rows inside the 60 s budget |
| C8 | **Operation & contact fuzzy matching** — scoring, top-three candidates, **threshold as configuration not a constant** | **[SONNET]** | C7 | *Escalated.* Match quality is judgement, and addendum §5 flags the threshold as open because the Louisiana candidate pool grows an order of magnitude. Suggest, **never** create — D16 is structural |
| C9 | **Preview table** — one row per input row, status chips, `"312 rows · 298 ready · 9 need review · 5 blocked"` header, commit enabled at zero blocked | **[HAIKU]** | C6 | Spec §5 |
| C10 | **Map preview panel** — parsed points over boundaries, colour by status, row↔pin hover | **[HAIKU]** | **B3** | Spec §6. Consumes Lane B's `<BoundaryMap>`; do not write a second MapLibre setup |
| C11 | **`/ingest/commit`** — RAW file bytes verbatim + hash, `PLAN_IMPORT`, `PLAN_IMPORT_ROW` for **every** row including blocked, then `SAMPLE_PLAN`/`SAMPLE_PLAN_POINT`, analyst-queue items, `AUDIT_EVENT`. Idempotent on `content_hash` + `imported_by` + mapping | **[OPUS]** | C7, A11 | *Escalated.* Multi-table ordered write, double-click safety, and the upsert-never-delete discipline. This is the one Lane C task where subtly wrong is expensive |
| C12 | **`/ingest/retire/{import_id}`** — retires the plan version, refuses once any point is sampled, `AUDIT_EVENT` on both outcomes including the refusal | **[SONNET]** | C11 | Spec §7 |
| C13 | **Tutorial branch** — the four-step walkthrough on the 12-row fault file, sandbox commit that is discarded, template download, sets `tutorial_completed_ts` | **[HAIKU]** | C9, C10, F0.7 | Spec §8. The fault table is written out row by row; this is transcription |
| C14 | **Analyst review queue** — a list over `V_SAMPLE_REVIEW_QUEUE`, defect resolve writing `AUDIT_EVENT`, operation/contact resolution UI | **[SONNET]** | A12, C8 | v02 week 6. **R1 says this is what gets cut if six weeks slips** — a Snowflake view plus a spreadsheet export survives one season |
| C15 | **Redraw the ERD** with the v02 tables | **[HAIKU]** | A12 | `sampling_erd.mermaid` is v01 only; `claude.md` next-step 5 |
| C16 | Acceptance tests v02 §11 items **8, 9, 10** — ≥95% lab match with the remainder `unmatched`, 300-row clipboard-to-committed under 30 s, swapped lat/lon caught and fixed in one click | **[HAIKU]** | C6–C13 | |

---

## 4. File ownership — the table that prevents collisions

Rule: **a lane may only write under paths it owns.** Reading anything is always fine.

```
src/shared/contract/**      A   the wire types. Changes are announced, never silent
src/shared/codes/**         A
src/shared/db/**            A
src/shared/snowflake/**     A
src/shared/auth/**          A
src/shared/map/**           B   ← the one shared-namespace file B owns, not A
src/sync/**                 A   outbox worker
src/app/**                  B   sampler screens, capture, components
src/ingest/**               C   parse, mapping, validation, preview
src/analyst/**              C
netlify/functions/sync-*        A
netlify/functions/assignments-* A
netlify/functions/derive-*      A
netlify/functions/nightly-*     A
netlify/functions/auth-*        A
netlify/functions/ingest-*      C
tools/pmtiles/**            B
fixtures/**                 C   (A and B add via a request file — see rule 3)
ddl/**                      A
netlify.toml                A   pre-declared in F0.2; should never need editing
package.json / lockfile     A   see rule 2
*.md at root                A   plan docs. Lane notes go in lanes/
```

---

## 5. The seven rules that keep three instances out of each other's way

1. **Three git worktrees, three branches.** `git worktree add ../lane-a lane/a-sync-spine` and so on, off `claude/concurrent-dev-plan-models-pchuxy`. Separate worktrees mean separate `node_modules`; never run two instances in one checkout.
2. **Only Lane A adds dependencies.** F0.3 installs everything up front precisely so this rarely comes up. A lockfile conflict between three lanes is a bad hour, and it is entirely avoidable.
3. **Cross-lane requests go in `integration/requests-<lane>.md`** — one file per lane, so appending never conflicts. "Lane B needs `MediaTicket.expires_ts` as a string not a Date" goes there; it does not go in a direct edit to `src/shared/contract/`.
4. **Integrate at end of day, in lane order A → B → C.** Each lane rebases onto the integration branch before pushing. A daily rebase is fifteen minutes; a Friday rebase is a day.
5. **The one real cross-lane dependency is B3 → C10.** Lane B ships `<BoundaryMap>` with a documented prop API by **end of day 3**. Until then Lane C works against the F0.9 stub. If day 3 slips, Lane C reorders to C11–C13 and comes back to the map — it is not on C's critical path.
6. **`npm run typecheck && npm test` passes before every push.** The shared contract is the only thing that can break all three lanes at once, and typecheck is what catches it.
7. **Escalation is explicit.** Seven tasks are tagged above their lane's default (A8 and F0.5 down, B6, B8, C7, C8, C11 up). If a lane finds itself escalating something *not* on that list more than once in a day, that is signal about the cut, not about the model — note it in the lane's request file.

---

## 6. What is genuinely blocking, and it is not engineering

Unchanged from v02 §10 pre-work, restated because three instances make the blocking items more expensive, not less:

1. **Snowflake service user + key-pair auth + network policy.** Blocks A1, and A1 blocks A2, A4, A6, C7 and C11. Three days to approve. **Make this call before opening any instance.**
2. **Thane's actual current spreadsheet.** Lane C's entire mapping layer (C4, C5) is being built against a guess until this exists. It is the column-mapping fixture.
3. **Real barcode labels from Agidata.** B7 is symbology-agnostic by design, so this does not block — but the crew cannot leave without a real label in hand.
4. **BCarbon confirmation on exception-based depth/core evidence.** One column in B9 if the answer is no, and far cheaper now than in week five.
5. **Fall window and crew size.** Sizes B13's route packs and the pilot.

---

## 7. Honest limits of this cut

- **Three instances do not make six weeks into two.** They compress weeks 3–5. The binding constraint becomes human review bandwidth across three concurrent diffs, and integration is now a risk that the sequential plan did not carry.
- **Lane A is the critical path and cannot be parallelised further.** A3 → A4 → A6 → A7 is strictly ordered. If Lane A slips, the season slips; B and C finishing early does not help.
- **Lane C at Haiku is the experiment.** If C1–C6 come back needing rework rather than review, the cut is wrong and Lane C should move to Sonnet wholesale. Decide that at end of week 1, on evidence, not at week 4.
- **v02 R1 still governs.** If six weeks tightens, cut C14 (the analyst queue UI). A Snowflake view and a spreadsheet export survive one season; a lossy capture path does not.
- **Model IDs and prices** — `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001` — were checked 2026-08-16 per plan v02 Appendix A. Re-verify before budgeting.
