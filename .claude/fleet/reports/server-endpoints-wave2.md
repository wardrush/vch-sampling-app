# server-endpoints — wave 2

**Task:** the follow-up I reported at the end of my previous pass — with
`isMockMode()` fixed to key off `sqlBackend()`, `assignments-bundle.ts`'s live
branch became reachable under `SQL_BACKEND=postgres` while still typed against
`SnowflakeClient` all the way down, so `/v1/assignments/bundle` threw `missing
required environment variable SNOWFLAKE_ACCOUNT` under the deployed MVP
configuration. Port `netlify/functions/assignments-bundle.ts` and
`src/server/assignments/bundle.ts` to the `SqlClient` port, following the
pattern `sync-spine` and `schema-steward` already established. `assignments-
bundle` only — A9 (nightly) and C14 (analyst queue) are out of scope for this
pass, per the task.

**Gate:** `npm run typecheck && npm test` → **pass**. `tsc --noEmit` clean.
`vitest run` → **24 files, 261 passed, 1 skipped** (baseline going in was 23 /
254 / 1 per `sync-spine`'s report; the delta is the 7 tests in the one new
file this pass adds — `tests/unit/assignments-bundle-live.test.ts`). `npm run
build` succeeds. `npm run db:migrate:dry` runs clean — 79 statements, "Nothing
was applied and no database was contacted." `npm run lint` still cannot run
repo-wide (ESLint 9 flat-config migration, predates this pass, orchestrator-
owned, reported by every prior lane).

**This ran against a tree `pwa-screens`/`capture-integrity`/`spec-transcriber`
were plausibly still writing to (FLEET.md §4.5).** `git status --short` at the
end of the run shows unrelated modifications under `src/app/**` — not mine,
not touched by me, listed in "Files touched" below for the record. The
authoritative gate is `fleet-integrator`'s, not this one.

**No live database of either kind exists.** Nothing here has been executed
against a real Postgres or Snowflake. Verified by unit test (`FakeSqlClient`,
both dialects), `npm run db:migrate:dry`, and one live-process smoke check
against the *mock* branch (below) plus one against the *live* branch that
proves the failure mode changed (also below) — neither touches a real
database. What stays unverifiable without a connection is listed in §"Not
verified" below.

---

## Landed

| Task | Files | What it does |
|---|---|---|
| Port `assembleLiveBundle` | `src/server/assignments/bundle.ts` | `LiveBundleDeps.snowflake: SnowflakeClient` → `SqlClient` (field name unchanged, per the established convention). `boundaryIdsForCrew`, `loadPlanPoints`, `loadAccessContacts` widened with no SQL change (plain ANSI). `loadBoundaries` and the `REF.PROJECT_SAMPLING_SPEC` query gained a dialect branch (see below). |
| Port the function wrapper | `netlify/functions/assignments-bundle.ts` | `snowflake()` → `sqlClient()`. Two-line change; `isMockMode()` branch (already fixed in a prior pass) and the fixture path (`mockBundle()`) are byte-for-byte untouched. |
| New test coverage | `tests/unit/assignments-bundle-live.test.ts` (new) | 7 tests: `assembleLiveBundle` against `FakeSqlClient` on **both** dialects (`describe.each(BOTH_DIALECTS, ...)`, reused from `tests/acceptance/support/fake-sql-client.ts` rather than inventing a third fake) — returns a bundle instead of throwing, decodes boundary geojson/bbox/centroid identically on both backends, never emits Snowflake-only syntax on Postgres or vice versa; plus one test that `loadAccessContacts`'s swallowed failure is now logged. |

### The one genuine dialect gap: `loadBoundaries`

Snowflake's `V_BOUNDARY_ENTITY.GEOG` is real geography and the original query
derives GeoJSON/bbox/centroid with `ST_ASGEOJSON`/`ST_XMIN`.../`ST_CENTROID`.
Postgres has no PostGIS. Per the task instruction, this is gated on
`client.capabilities.geospatial` (the existing capability flag, not a new env
var) rather than on dialect directly — same variable name `schema-steward`'s
`postgres_sampling_v01.sql` and `sync-spine`'s `derive/pipeline.ts` both use
for the identical question.

**Nothing is silently missing on the Postgres branch.** I checked before
assuming, per the task's instruction: `CURATED.BOUNDARY_CACHE`
(`postgres_sampling_v01.sql` §3, and `CURATED.V_BOUNDARY_ENTITY` is a view
over it, §8) stores `GEOJSON` as `jsonb` and the bbox/centroid **precomputed**
— specifically so downstream reads never need a geospatial engine. So the
Postgres branch of `loadBoundaries` is a plain column read against those
precomputed values, not a degraded feature. The two SQL branches project to
the *same* column aliases (`geojson_raw`, `west`/`south`/`east`/`north`,
`centroid_lat`/`centroid_lon`, …) so the row-mapping code — the part that
turns a `StatementResult` into `AssignedBoundary[]` — is shared and cannot
drift between backends. Verified in the new test: the same `GeoJsonPolygon`
object round-trips through both the Snowflake-shaped `geojson_raw` string
(what `ST_ASGEOJSON` would return) and the Postgres-shaped one (what
`normaliseValue()`'s `JSON.stringify` on a `jsonb` value returns) — both are
JSON text and `JSON.parse` is dialect-agnostic, so this one is closer to
byte-identical than most of the port.

**`REF.PROJECT_SAMPLING_SPEC`'s `CURRENT_DATE()` vs `CURRENT_DATE`** is the
other dialect gap in this file (Postgres rejects the parens, same shape as
`CURRENT_TIMESTAMP()` elsewhere in the codebase). Gated on
`capabilities.mergeInto` as the "is this Snowflake-flavoured SQL" flag,
matching `src/ingest/retire/index.ts`'s identical `capsOf(sf).mergeInto ?
'CURRENT_TIMESTAMP()' : 'CURRENT_TIMESTAMP'` pattern rather than inventing a
new discriminator.

### `capsOf()` — copied, not reinvented

Added the same defensive helper `src/ingest/commit/index.ts` and
`src/ingest/retire/index.ts` use: falls back to `SNOWFLAKE_CAPABILITIES` if a
client structurally satisfies `SqlClient` at compile time but its
`.capabilities` is missing at runtime (the shared, unowned
`tests/support/fake-snowflake.ts`'s `asClient()` cast bypasses the structural
check). No new fake was built for this — I did not touch that shared file
either.

### `loadAccessContacts` — failure now visible, behaviour otherwise identical

Per the agent file's non-negotiable, still returns `[]` on a query failure
(the guessed `CURATED.ACCESS_CONTACT` table, confirmed absent from
`postgres_sampling_v01.sql` too — schema-steward's report §7 lists it as
explicitly out of scope). The bare `catch { return []; }` is now
`catch (err) { console.error(...); return []; }`, naming the guessed table
and pointing at `integration/requests-a.md`, so "no access contacts
configured" and "the query broke" no longer read identically in the logs.
Covered by a new test that intercepts the statement with `FakeSnowflake`'s
`failWhen()` and asserts both the `[]` result and that `console.error` fired.

---

## Contract or interface changes others need

None. `LiveBundleDeps.snowflake` widened from `SnowflakeClient` to `SqlClient`
— field name unchanged, so no caller needed to change beyond the netlify
function wrapper. Nothing exported from `src/server/assignments/bundle.ts`
changed shape.

---

## Stopped, and why

- **Did not touch the three known schema-name gaps.** `boundaryIdsForCrew`
  still ignores `crew_org_id` and falls back to "every boundary with a
  released plan for the period" — unchanged behaviour, unchanged comment.
  `loadAccessContacts` still queries the guessed `CURATED.ACCESS_CONTACT`
  name — I made its failure loud, not its guess more confident. Neither table
  exists on Postgres either (confirmed against `postgres_sampling_v01.sql`
  before writing anything, not assumed).
- **Did not touch `netlify/functions/{nightly,analyst}-*` or
  `src/server/{nightly,dev}/**`.** Out of scope for this pass by the task's
  explicit instruction ("Scope: `assignments-bundle` only").
- **Did not add a `geo_capability`/"geometry unverified" field to the bundle
  response.** Unlike the derivation pipeline, nothing is actually degraded
  here to disclose — `BOUNDARY_CACHE` carries real (or fixture) GeoJSON either
  way, so there was nothing missing to make visible on this endpoint
  specifically. If a caller wants to know whether the *server-side* boundary
  containment / offset checks ran (as opposed to whether GeoJSON was
  deliverable), that is `CURATED.V_SAMPLE_GEO_ASSURANCE` per row, not this
  bundle — and `AssignmentBundle`/`AssignedBoundary` are `schema-steward`'s
  (`src/shared/contract/**`), not mine to extend regardless.
- **Did not touch `src/shared/db/port.ts`, `dialect.ts`, or DDL.** Read-only,
  as required. Where I needed dialect-specific SQL text I built it locally in
  `bundle.ts` with `capsOf(sf)`, the same pattern `src/ingest/commit/index.ts`
  and `src/ingest/retire/index.ts` already use — not `syntaxFor()` from
  `src/server/sync/dialect.ts`, which is `sync-spine`'s path and which no
  other lane imports from either (checked: only `pipeline.ts` and
  `sync-media-commit.ts`, both `sync-spine`'s own files, import it).
- **`fixtures/bundle.f26-demo.json` and `mockBundle()` — untouched, verified
  by smoke test.** See below.

---

## Needs from another agent

None new. The three schema-name gaps (`boundaryIdsForCrew`,
`loadAccessContacts`, and — for a different lane —
`findOperationCandidates`/`findContactCandidates`) are already recorded in
`integration/requests-a.md` from the prior pass; I did not add a duplicate
entry, and this pass changed nothing about what is being asked for there.

---

## Verification beyond the test suite

**1 · The mock branch is unchanged**, run live with no `SNOWFLAKE_*`,
`NETLIFY_DATABASE_URL`, or `SQL_BACKEND` set at all:

```
status 200
bundle_id 01ARZ3NDEKTSV4RRFFQ69G5FAV boundaries 1 plan_points 6 specs 1
```

Matches `fixtures/bundle.f26-demo.json` (1 boundary, 6 plan points, 1 spec) —
the shape `pwa-screens` is building the four flow screens against was not
touched.

**2 · The live branch is reachable, and the failure mode changed** — this is
the actual bug being fixed, demonstrated rather than only asserted. Run with
`SQL_BACKEND=postgres` and a syntactically-valid but unreachable
`NETLIFY_DATABASE_URL` (`postgres://user:pass@nonexistent.invalid/db`), no
`SNOWFLAKE_ACCOUNT`:

```
THREW: Error connecting to database: TypeError: fetch failed
```

Before this pass, the identical environment threw `missing required
environment variable SNOWFLAKE_ACCOUNT` **before any network call was
attempted** — `snowflake()` failed at `env.ts`'s `required()` before
`assembleLiveBundle` ever ran a query. Now it reaches the Postgres HTTP driver
and fails only because there is no real database at that URL in this
environment, which is the honest ceiling stated in the task. This is the
concrete proof that `/v1/assignments/bundle` no longer throws the
Snowflake-shaped error under the Postgres backend.

## Not verified, and cannot be, without a connection

1. **Whether the generated `SELECT ... IN (?,?,...)` boundary/plan-point
   queries parse and return correctly against a real Postgres instance.**
   Checked by hand and by the `FakeSqlClient`-driven tests (which drive
   through `PostgresClient`'s `?`→`$n` rewriter for the bind count, but not a
   real connection) — same ceiling every other lane in this wave reports.
2. **Whether `CURATED.BOUNDARY_CACHE` is actually populated in any given
   deploy.** Per `schema-steward`'s report §8, the loader that fills it "is
   not written" — a live deploy with an empty cache will return `boundaries:
   []` and `plan_points: []` correctly (not an error) but the bundle will be
   empty for a real crew until that loader exists or fixtures are seeded.
   That gap is pre-existing and out of scope here; noting it because it is
   the most likely reason a first live run of this endpoint looks "empty but
   not broken."
3. **`REF.PROJECT_SAMPLING_SPEC.EFFECTIVE_END >= CURRENT_DATE` behaviour**
   against a real Postgres clock/timezone — the `CURRENT_DATE` (no-parens)
   rewrite is standard SQL and was checked by hand, but never executed.
4. **Real `If-None-Match` / ETag round-trip against a warm Netlify function
   container** — unaffected by this pass (the wrapper's 304 logic was not
   touched), but calling it out since it is adjacent and easy to assume
   tested.

---

## Files touched

`git status --short`, verbatim (other lanes' files included; mine marked):

```
 M netlify/functions/assignments-bundle.ts        <- mine
 M src/app/App.tsx
 M src/app/components/index.ts
 M src/server/assignments/bundle.ts                <- mine
?? .claude/fleet/reports/spec-transcriber-wave2.md
?? src/app/components/DepthCoresToggle.tsx
?? src/app/components/DeviationPicker.tsx
?? src/app/screens/skip/
?? src/app/screens/storage/
?? src/app/shell/device-id.ts
?? tests/unit/assignments-bundle-live.test.ts      <- mine
```

`src/app/**` and `.claude/fleet/reports/spec-transcriber-wave2.md` are
`spec-transcriber`'s, written concurrently while I ran (FLEET.md §4.5) — not
touched by me, listed only so this report's diff matches what
`fleet-integrator` will actually see. No file was written outside
`src/server/assignments/**`, `netlify/functions/assignments-*`, and this
report. No git command that writes was run.
