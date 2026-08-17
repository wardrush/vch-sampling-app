# Sonnet tasks — status

*Companion to `CONCURRENT_BUILD_PLAN_v01.md`. Every task tagged **[SONNET]**
in that plan, and what state it is in. Read this before starting more Sonnet
(or any) work on this repo — it is the handoff note.*

**Branch:** `claude/sonnet-abc-plan-tasks-6aos2o`, based on `master` at
`892fcf4` (after PR #1 concurrent-plan, PR #2 Opus, PR #3 Haiku were merged).

---

## Read this first: F0 did not happen the way the plan describes

The plan assumes one Opus instance runs all of F0 before Lane B/C open. What
actually happened: separate Opus and Haiku sessions each ran ahead on
`master` under their own branch names, picking up whichever F0/lane tasks
matched their tag, in parallel with **this** Sonnet session — three
independent sessions converging on one repo without the F0 gate the plan
assumes. All three are now merged into `master` via PRs #1–#3. This session
started from an *earlier* commit, wrote its own (now-discarded) scaffold, and
only discovered the real state after being told about the merge — see the
git log for the full sequence if the "why" here is unclear.

**Net effect, and it's a good one:** Opus's F0.4/F0.6 and A1/A3–A7/A10/A11 +
B6/B8/C11 are real, tested, working code — not the mocked-infra placeholders
the concurrent plan expected Lane A to still be missing when B/C opened. The
Sonnet tasks below were built *against that real infra*, not against F0.8
mocks pretending it doesn't exist yet, except where no real infra exists to
build against (see the schema gaps below).

---

## Done

| # | Task | Where | Notes |
|---|---|---|---|
| **F0.1** | Vite + React + TS scaffold, completing Opus's minimal `package.json`/`tsconfig.json` | `vite.config.ts`, `index.html`, `src/main.tsx`, `src/app/App.tsx`, `.eslintrc.cjs`, `.prettierrc.json` | Added React/JSX/DOM to the **existing** flat `tsconfig.json` rather than splitting it — Opus's tsconfig already serves the Node backend + Vitest; it now also serves the browser app. One tsconfig, one `npm run typecheck`. |
| **F0.2** | `netlify.toml`, every function + redirect declared | `netlify.toml` | Reconciled against the **real** function files (`sync-batch`, `sync-media-*`, `auth-session`, `derive-batch-background`, `ingest-commit`) rather than the guessed names in the plan doc. `auth-session.ts` serves both the ingest token-URL and sampler device-enrolment via `Bearer` — there is no separate `auth-ingest-token`/`auth-device-enroll` function, so `netlify.toml` routes `/ingest/:token` straight to `auth-session`. |
| **F0.3** | Full dependency install | `package.json`, `package-lock.json` | `maplibre-gl`, `pmtiles`, `wa-sqlite`, `@zxing/browser`+`library`, `xlsx`, `exifr`, `@netlify/blobs`, `jose`, `react`/`react-dom`/`react-router-dom`, `vite`+`vite-plugin-pwa`, eslint/prettier toolchain. `wa-sqlite` is pinned `^1.0.0` — `^0.9.9` from the plan doc doesn't exist on npm. |
| **F0.7 cleanup** | Haiku's fixtures/codes landed as literal-underscore filenames at repo root (`fixtures_bundle.f26-demo.json`, `src_shared_codes_condition.ts`, etc.) instead of under `fixtures/` and `src/shared/codes/` — a path bug in that session, not a design choice (their own barrel-file comment says as much). Moved into place with `git mv`, wired into `src/shared/codes/index.ts`'s barrel export. Dropped the one file (`defect.ts`) that duplicated names Opus's `index.ts` already defines. | `fixtures/**`, `src/shared/codes/{condition,deviation,priority,validation}.ts` | Not a Sonnet task per se — did it because F0.8 and everything downstream needed the fixtures reachable at the paths the code actually imports. |
| **F0.8** | Mock function server | `src/server/dev/{mock-mode,fixtures}.ts` | Scope narrower than the plan envisioned, because most endpoints are no longer mocks — they're real and require real Snowflake credentials by design (`env.ts` fails loudly, deliberately). `isMockMode()` (true when `SNOWFLAKE_ACCOUNT` is unset, or `MOCK_SNOWFLAKE=1`) is what the *new* endpoints below check; each one falls back to F0.7 fixtures instead of a warehouse call. `netlify dev` with zero `SNOWFLAKE_*` env vars now serves A2, C7, C8, C12 end-to-end. |
| **A2** | `GET /v1/assignments/bundle` | `src/server/assignments/bundle.ts`, `netlify/functions/assignments-bundle.ts` | ETag over the bundle *minus* `server_time`/`expires_ts` (both change every request; including them would defeat `If-None-Match` entirely). Real-mode boundary/plan-point/spec/ref queries are real SQL against the actual DDL. **`crew_org_id` scoping is not real** — see schema gaps below. |
| **C7** | `POST /ingest/validate` | `src/ingest/validate/index.ts`, `netlify/functions/ingest-validate.ts` | PIP via a local ray-casting implementation (`src/shared/geo/point-in-polygon.ts`) in mock mode, `ST_WITHIN` in live mode — same logic contract §6 step 4 already uses server-side. Duplicate-against-released-plan check, implausible-distance check (haversine to nearest assigned boundary centroid), unmapped/elevation/strata advisories. Calls into C8 for operation/contact matching. |
| **C8** | Operation & contact fuzzy matching | `src/ingest/validate/match.ts` | Pure `scoreCandidates()`/`similarity()` — Levenshtein + token-Jaccard-with-containment (so `"Bring Farms"` scores strongly against `"Ben Bring Farms LLC"`, spec §8 row 7's tutorial fault). **`DEFAULT_MATCH_CONFIG` is exported, not hardcoded into the scorer** — addendum §5's point exactly: the threshold is configuration the caller can override, not a constant to import and forget. Candidate *lookup* queries guessed table names — see schema gaps. |
| **C12** | `POST /ingest/retire/{import_id}` | `src/ingest/retire/index.ts`, `netlify/functions/ingest-retire.ts` | Refuses via `POINTS_ALREADY_SAMPLED` when any `SAMPLE_POINT` exists under the import's plans; refuses `NOT_FOUND`/`ALREADY_RETIRED` otherwise. Both outcomes — retire and refusal — write `AUDIT_EVENT` (`IMPORT_RETIRE` / `IMPORT_RETIRE_REFUSED`, both already in `AUDIT_ACTION`). Retiring supersedes the plan(s) via the same `status='superseded'` convention `ingest-commit.ts` uses — no new status value invented. |
| **F0.9 (partial)** | Stubs for the two v1.5 down-sync endpoints declared in `netlify.toml` but out of v1 scope | `netlify/functions/sync-defects-{open,ack}.ts` | 501, one paragraph each pointing at addendum §4.2. Everything else F0.9 worried about ("no lane creates a file another lane imports") turned out to already be real, not needing a stub. |
| **Tests** | 14 new unit tests: C8 scoring, point-in-polygon, A2 etag stability, C7 validate against fake deps | `tests/unit/sonnet-additions.test.ts` | `npm run typecheck && npm test` — **94 tests, all passing** (80 pre-existing + 14 new), no network required. |

---

## Not started

- **A9** — nightly scheduled function. Not begun. Would follow the
  `derive-batch-background.ts` pattern: a `-scheduled` function (30 s
  ceiling, `netlify.toml` already declares its cron) that enumerates
  unsampled-plan-point sweeps and plan closes, then kicks a
  `nightly-sweep-background.ts` that does the actual work. `netlify.toml`'s
  `[functions."nightly-sweep-scheduled"]` block is declared and pointed at a
  function file that does not exist yet — that will 404 if deployed as-is.
- **C14** — analyst review queue. Not begun. `netlify.toml` declares
  `/analyst/review-queue` and `/analyst/review-queue/:item_id/resolve`
  redirects pointed at functions that don't exist yet, same caveat as A9.
  `CURATED.V_SAMPLE_REVIEW_QUEUE` (the view this reads) already exists in
  `snowflake_sampling_v01.sql` — the query and resolve-writes-`AUDIT_EVENT`
  logic are the remaining work, not the schema.
- **All of Lane B's Sonnet tasks** — B1 (PWA shell/service worker/OPFS
  bootstrap), B3 (`<BoundaryMap>`), B4 (Today), B5 (Field), B7 (barcode
  capture), B11 (Outbox), B13 (PMTiles route-pack builder). **Nothing under
  `src/app/` is a screen yet** — the only things there are Opus's B6/B8
  (`capture/gps.ts`, `capture/camera/**`), which are pure capture-logic
  modules with no UI wrapping them. There is currently no React route, no
  map, no way to actually see or use this app. This is the largest gap
  between "done" and what the concurrent plan describes for Lane B.
- **B15** — acceptance tests needing real hardware/a real field. Not
  buildable in this environment regardless; schedule them per the plan's own
  instruction ("time a real capture," not simulate it).

---

## Schema gaps found and isolated, not guessed past

Same discipline Opus used for `V_BOUNDARY_ENTITY`/`V_LAB_RESULT_ENTITY`
(`snowflake_v03_entity_compat.sql`): a wrong table-name guess deploys, fails
at query time, and looks like a code bug. Better to isolate the guess to one
place and say so. Full detail in `integration/requests-a.md`; short version:

1. **No `crew_org_id` → boundary assignment table.** A2's bundle scoping
   currently ignores `crew_org_id` and returns every boundary with a
   released plan for the period. Correct for a one-crew pilot, wrong once a
   second crew exists. `boundaryIdsForCrew()` in `bundle.ts` is the one
   function to fix.
2. **No `CURATED.ACCESS_CONTACT` table.** `loadAccessContacts()` guesses the
   name and swallows a query failure to `[]`. Contract §2 access contacts
   are the entire BYOD data-exposure story — worth confirming before a
   pilot, not silently shipping empty.
3. **No `CURATED.OPERATION` / `CURATED.PERSON` tables.** C8's candidate
   lookups guess names per `PLAN_INGEST_SPEC_v01.md` §3's
   `OPERATION.legal_name` reference.

None of these block `netlify dev` or `npm test` — `MOCK_SNOWFLAKE=1` (or
simply no `SNOWFLAKE_ACCOUNT` set) routes A2/C7/C8/C12 through the F0.7
fixtures instead, and that path has no dependency on any of the three gaps
above. They block a real pilot deploy.

---

## If you're picking this up next

1. **Lane B is the priority** — there is no usable app yet, and that is the
   actual deliverable. Start with B1 (needs nothing but F0.6, which is real)
   so there is a shell to put B3–B13 into, then B3 (`<BoundaryMap>`) since
   nothing else in Lane B or C's map preview can proceed without it.
2. **A9 and C14 are both short** — the hard parts (the defect harness, the
   review-queue view, the background-function pattern) already exist as
   working examples elsewhere in the repo to copy.
3. **Do not re-guess the three schema names above.** They're isolated to
   five functions total (`boundaryIdsForCrew`, `loadAccessContacts`,
   `findOperationCandidates`, `findContactCandidates`, and their two ingest
   callers). Fix in one place when the live names are confirmed.
4. Run `npm run typecheck && npm test` before every push — 94 tests, should
   stay green.
