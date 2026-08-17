# sync-spine — N2, `src/server/{sync,derive}/**` on the SQL port

**Task:** N2 — port the sync spine and the derivation pipeline to `SqlClient`
so `/sync/batch` and the derivation pipeline work on the Netlify database
(Neon Postgres) with Snowflake behaviour unchanged.

**Gate:** `npm run typecheck && npm test` → **pass**.
`tsc --noEmit` clean. `vitest run` → **23 files, 254 passed, 1 skipped**
(the acceptance suite is 6 files / 49 tests, up from 5 / 35).
`npm run build` succeeds. `npm run db:migrate:dry` runs clean —
79 statements, "Nothing was applied and no database was contacted."
`npm run lint` still cannot run repo-wide (ESLint 9 flat-config migration,
predates this pass, orchestrator-owned).

**This ran against a tree `ingest-lane` and `server-endpoints` were writing to
(FLEET.md §4.5).** Their files were green at the end of my run —
`src/server/dev/mock-mode.ts` and `src/ingest/**` are both already modified in
`git status` and their tests pass — but the authoritative gate is
`fleet-integrator`'s.

**No live database of either kind exists.** Nothing here has been executed
against Postgres or Snowflake. Verification is unit/acceptance tests, the real
`PostgresClient` driven by a recording executor, and `db:migrate:dry`. The
residual risks that only a connection can close are listed in §6 — that list is
the most useful part of this report for whoever runs the first deploy.

---

## 0. Read this first, three things

**1 · Three latent bugs were found, and all three would have failed on
Snowflake too.** None is caused by the Postgres port; the port is what made them
visible, because generating the same statement in two dialects forced the
column lists to be checked against the DDL.

| Bug | Effect before this pass | Now |
|---|---|---|
| **`/sync/batch` bound the batch id and the payload in the wrong order** | The generated SQL names `batchIdExpr` *before* `sourceExpr` (a projection precedes its `FROM`), but `batch.ts` bound `[payloads, batchId]`. So `SYNC_BATCH_ID` got a JSON array and `PARSE_JSON`/`::jsonb` got a batch id. **Every entity write in `/sync/batch` would have failed** on either backend | Fixed. `curatedWriteForPayload()` now returns SQL and binds together so a caller cannot transpose them, and `tests/acceptance/05` pins the ordering relationship |
| **`CURATED.SAMPLE_CONDITION` was stamped with `LAST_UPDATED_TS` / `LAST_UPDATED_BY`** | The table has neither column, in **either** DDL file. Invalid identifier → every `sample_condition` write fails | Fixed. `auditStamped: false` on that mapping |
| **`CURATED.SAMPLE_DEFECT` was stamped with `SYNC_BATCH_ID`** | The table has no such column in **either** DDL file. Device-raised `local_defect` records have never been writable | Worked around, not decided: `batchStamped: false`. Whether the column should exist is `schema-steward`'s call — request 2 in `integration/requests-a.md` |

The check that found the last two is new and cheap:
`tests/acceptance/06-dual-backend-parity.test.ts` → *"every column the parser
writes exists in the DDL"*, which parses `postgres_sampling_v01.sql`,
`snowflake_sampling_v01.sql` and `snowflake_v02_addendum.sql` and asserts every
column of every mapping. It runs offline and it is the closest thing to a live
database this repo has.

**2 · Defect detection does not run on Postgres yet, and it is not mine to
fix.** `src/server/defects/harness.ts` (A7) still writes its findings with
`PARSE_JSON` + `FLATTEN` + `MERGE` and is typed against `SnowflakeClient`. It is
**unowned** in FLEET.md §1 — `defect-rules` owns `rules/**` only — so I stopped
rather than reaching across, and wrote the exact patch into
`integration/requests-a.md` (request 1). Until it lands, on Postgres:

- step 7 is skipped and recorded in `DERIVATION_RUN.STEPS_SKIPPED`;
- **step 8 is skipped with it** — a review state written from a screening that
  never happened is the precise lie the geo-assurance design exists to prevent —
  so rows stay `captured` and read as `awaiting_derivation` in
  `CURATED.V_SAMPLE_GEO_ASSURANCE`.

The seam is already in place: `PipelineDeps.runRules` overrides step 7, which is
also how the tests exercise step 8 on the Postgres path today. When the harness
is widened, delete `harnessRunsOn()` and nothing else changes.

**3 · `/sync/batch` itself is complete on Postgres** — RAW, the five entity
upserts, the batch row and the device stamp — and every statement it issues has
been driven through the *real* `PostgresClient`, which rewrites `?` → `$n`,
refuses a placeholder/bind mismatch and splits `executeMulti`'s flat bind array.
That is `tests/acceptance/06` → *"the Postgres write path is a valid
parameterised query, statement by statement"*.

---

## 1. Landed

| Area | Files | What it does |
|---|---|---|
| Dialect seam | `src/server/sync/dialect.ts` **(new)** | `syntaxFor(client \| dialect)` → `now`, `currentUser`, `parseJson`, `jsonScalar`, `jsonSubtree`, `jsonArrayRows`, `ordinal`, `jsonArrayAgg`. The only place that knows `CURRENT_TIMESTAMP()` vs `CURRENT_TIMESTAMP`, `v.value:k::VARCHAR` vs `(v.value ->> 'k')::text`, `FLATTEN` vs `jsonb_array_elements` |
| Curated write | `src/server/sync/merge.ts` | One column mapping, two forms: `MERGE INTO … USING` and `INSERT … ON CONFLICT (pk) DO UPDATE … WHERE guard`. Adds `curatedWriteForPayload()` (SQL + binds together), `keyPathFor()`, `columnsFor()`, `keyColumnFor()`, and the `auditStamped` / `batchStamped` flags |
| `/sync/batch` | `src/server/sync/batch.ts` | `SqlClient` throughout; dialect-aware RAW persist (`PAYLOAD_TEXT` + `PAYLOAD` from one decode on Postgres), batch row upsert, key de-duplication, and a rewritten rebuild path |
| Derivation | `src/server/derive/pipeline.ts` | Geospatial steps gated on `capabilities.geospatial`; `GEO_DERIVATION_STATE` stamped; clean state via `cleanReviewStateFor()`; `CURATED.DERIVATION_RUN` recorded; `raiseDefectFromQuery` ported; `runRules` seam |
| Functions | `netlify/functions/sync-batch.ts`, `derive-batch-background.ts`, `sync-media-commit.ts` | `snowflake()` → `sqlClient()`; media commit's two statements are dialect-aware |
| Tests | `tests/acceptance/03,04,05` updated; `06-dual-backend-parity.test.ts` and `support/fake-sql-client.ts` **(new)** | 04 and 05 now run against **both** dialects (`describe.each`); 06 is the port's own suite |

Nothing was written outside `src/server/{sync,derive}/**`,
`netlify/functions/{sync,derive}-*`, `tests/acceptance/**`, this report and the
append-only `integration/requests-a.md`. **No git command that writes was run.**

### Geospatial deferral, concretely

`capabilities.geospatial === false` ⇒ steps 4 (point-in-polygon), 5 (TRS) and 6
(offset/bearing) do not run. What is recorded instead:

```
result.geo_capability   = 'none'
result.steps            = ['geography', 'defect_rules', 'review_state']
result.steps_skipped    = ['point_in_polygon', 'trs', 'offset_from_plan']
result.rules_not_run    = ['POINT_OUTSIDE_BOUNDARY', 'OFFSET_EXCEEDED_NO_REASON']
result.clean_review_state   = 'screened_partial'      // cleanReviewStateFor()
result.geo_derivation_state = 'deferred_no_geospatial'
```

- **The two rules are visibly not-run.** `POINT_OUTSIDE_BOUNDARY` is *not*
  raised — with no containment test every row would get one, which is a false
  positive on 100% of the data — and `OFFSET_EXCEEDED_NO_REASON` fails silently
  by construction (`offset_from_plan_m === null` is a `continue`). Both are named
  in `rules_not_run`, which lands in `DERIVATION_RUN.DETAIL_JSON`.
- **`GEOM_INVALID` still fires**, because on this backend `GEOG_VALID` reduces to
  "lat/lon present and in range", which is arithmetic. Per row,
  `GEO_DERIVATION_STATE` is `deferred_no_geospatial` for an in-range coordinate
  and `invalid_geometry` for a missing or out-of-range one.
- **The clean state goes through `cleanReviewStateFor()` and travels as a bind**,
  never as a literal — so `SAMPLE_POINT_SCREENED_REQUIRES_GEO` is what enforces
  it, not a string in this file.
- **`DERIVATION_RUN` is written on every run, including a failed one** (recorded
  then rethrown), and never fails a derivation — the bookkeeping is not worth
  losing a batch's screening over. It is gated to Postgres because the table has
  no Snowflake counterpart yet (request 3).

### The rebuild path changed, and it is a correctness fix

`rebuildCuratedFromRaw` used to aggregate **every** RAW record of an entity type
into one array and merge it. `ARRAY_AGG` / `jsonb_agg` over many payloads has no
defined order, so a sample corrected in a later batch could be rebuilt from the
*earlier* payload. **A rebuild that is not deterministic does not satisfy v02 §11
criterion 5 whatever it produces.** It now replays one RAW payload at a time in
`RECEIVED_TS` order, parents before children, re-stamping each row with the
`SYNC_BATCH_ID` it originally arrived under — so the derivation pipeline, which
is keyed on that column, can be re-run over rebuilt rows exactly as it was the
first time. `curatedMergeSql`'s single-parse property is untouched: the rebuild
still differs from the live path only in the source expression, asserted per
dialect by `tests/acceptance/05`.

### Duplicate client keys

`ON CONFLICT DO UPDATE` refuses to affect the same row twice in one statement, so
a source array carrying the same client key twice is a hard error on Postgres —
and the outbox would retry that batch forever. Snowflake, which enforces no
primary key, would instead have inserted two rows under one `SAMPLE_UID`. Neither
is acceptable, so the last occurrence per key now wins, in two places: in
TypeScript before the live write (both backends), and in the SQL via
`ROW_NUMBER() … ORDER BY <ordinality> DESC` on the Postgres path, which is what
covers the rebuild where the array comes out of RAW. "Last wins" is the same
precedence the outbox already applies via its own `ON CONFLICT DO UPDATE` on
`(entity_type, entity_id, operation)`.

---

## 2. Contract or interface changes others need

```ts
// src/server/sync/dialect.ts — NEW. Anyone writing SQL for both backends.
export function syntaxFor(source: SqlDialect | Pick<SqlClient, 'dialect'>): SqlSyntax;
export interface SqlSyntax {
  readonly dialect: SqlDialect;
  readonly now: string;           // CURRENT_TIMESTAMP() | CURRENT_TIMESTAMP
  readonly currentUser: string;   // CURRENT_USER()      | CURRENT_USER::text
  parseJson(bind?: string): string;
  jsonScalar(expr: string, key: string, type: JsonScalarType): string;
  jsonSubtree(expr: string, key: string): string;
  jsonArrayRows(sourceExpr: string, alias: string): string; // `<alias>.value` on both
  ordinal(alias: string): string;
  jsonArrayAgg(expr: string): string;
}

// src/server/sync/merge.ts
export function curatedMergeSql(
  entityType: MergeableEntityType, sourceExpr: string, batchIdExpr: string,
  dialect: SqlDialect = 'snowflake',   // ← added; default keeps every old caller
): string;
export function curatedWriteForPayload(       // NEW — use this, not the above
  entityType: MergeableEntityType, payloadsJson: string,
  syncBatchId: string, dialect: SqlDialect,
): { sql: string; binds: BindValue[] };
export function keyPathFor(t: MergeableEntityType): string;
export function keyColumnFor(t: MergeableEntityType): string;
export function columnsFor(t: MergeableEntityType): string[];

// src/server/sync/batch.ts
export interface SyncBatchDeps { snowflake: SqlClient; /* field name unchanged */ }
export function rawRebuildSourceSql(t: MergeableEntityType, d: SqlDialect): string; // NEW
export function listBatchRawHashes(db: SqlClient, syncBatchId?: string): Promise<…>; // + filter
export function rebuildCuratedFromRaw(db: SqlClient, entityTypes, syncBatchId?): Promise<void>;

// src/server/derive/pipeline.ts
export interface PipelineDeps {
  snowflake: SqlClient;
  harness?: Omit<DefectHarnessDeps, 'snowflake'>;
  runRules?: (syncBatchId: string) => Promise<number>;   // NEW — step 7's seam
}
export interface PipelineResult {   // additive; existing fields unchanged
  run_id: string; backend: SqlDialect; geo_capability: 'full' | 'none';
  steps_skipped: string[]; rules_not_run: string[];
  clean_review_state: ReviewState; geo_derivation_state: GeoDerivationState;
  /* + sync_batch_id, steps, defects_raised, samples_screened, samples_needing_review */
}
export function harnessRunsOn(db: SqlClient): boolean;   // delete when A7 is ported
export function raiseDefectFromQuery(sf: SqlClient, …);  // widened from SnowflakeClient
export const PIPELINE_VERSION = 'derive-v02.2';
```

`samples_screened` now counts rows in **whichever clean state this run wrote**
(`screened` or `screened_partial`), so a Postgres run does not report zero.

---

## 3. Stopped, and why

- **`src/server/defects/harness.ts` — not written.** Unowned, and the task said
  to report rather than reach across. The consequence is real and named in §0.2;
  the patch is written out in `integration/requests-a.md` request 1. I considered
  duplicating the harness's orchestration inside `src/server/derive/**` to keep
  the MVP screening alive, and rejected it: two writers for one defect set is the
  same failure this lane's "one parse, two callers" rule exists to prevent, and
  it would diverge within a season.
- **`CURATED.SAMPLE_DEFECT.SYNC_BATCH_ID` — not added.** Adding a column to two
  DDL files is a schema decision. Removing a write to a column that exists in
  neither is not. So the mapping carries `batchStamped: false` and the question
  is request 2.
- **`CURATED.DERIVATION_RUN` on Snowflake — not created.** `*.sql` is
  `schema-steward`'s. The insert is gated by `DERIVATION_RUN_BACKENDS`, one line
  to delete. Request 3.
- **No app-side geospatial derivation.** `src/shared/geo/**` already has
  `pointInPolygon`, `haversineMetres` and `bearingDegrees`, so `derived_planar`
  is buildable — but planar containment and geodesic `ST_WITHIN` disagree at
  boundary edges, the user's call was to defer, and the DDL reserves the state
  precisely so lifting the deferral later is a code change and not a migration.
- **The three known schema-name gaps are untouched**, as instructed:
  `boundaryIdsForCrew`, `loadAccessContacts`,
  `findOperationCandidates`/`findContactCandidates`.
- **No dependency added, removed or upgraded.** `uuidv7` was already a
  dependency and is now used for `DERIVATION_RUN.RUN_ID`.
- **`PIPELINE_VERSION = 'derive-v02.2'` is a label I chose.** It is free-form in
  the DDL and nothing reads it; rename it if there is a convention I missed.

---

## 4. Needs from another agent

All four are in `integration/requests-a.md` under
*2026-08-17 · sync-spine*, with the patches spelled out:

1. **`src/server/defects/harness.ts` → `SqlClient` + port `writeFindings`.**
   **Blocking** for defect detection on the Netlify database. Owner unassigned —
   the third unowned path this work has hit, after `src/server/env.ts` and
   `src/shared/auth/**`.
2. **`CURATED.SAMPLE_DEFECT.SYNC_BATCH_ID`** — add it to both DDLs and delete
   `batchStamped`, or confirm the current design. `schema-steward`.
3. **`CURATED.DERIVATION_RUN` + `SAMPLE_POINT.GEO_DERIVATION_STATE` on
   Snowflake** — makes the geo-assurance view portable and gives the production
   backend a run history. Not blocking. `schema-steward`.
4. **Two port-typed fakes now wrap `tests/support/fake-snowflake.ts`** — mine
   (`tests/acceptance/support/fake-sql-client.ts`, a subclass) and
   `ingest-lane`'s (`asPostgresClient()` in `tests/unit/ingest-postgres-port.test.ts`).
   Both exist because the shared fake belongs to neither lane. Worth collapsing
   after the wave; nothing depends on which is used.

---

## 5. How the "RAW is hashed over the original bytes" claim was verified

Not by reading the code — by asserting on the binds the write actually issues.
`tests/acceptance/05` → *"stores text that hashes back to RAW_PAYLOAD_HASH, from
one decode"* posts a body containing an unsorted **and duplicated** JSON key —
a shape `jsonb` and `VARIANT` both provably cannot give back — through
`handleSyncBatch` on the Postgres path, then checks the recorded statement:

- `sha256(PAYLOAD_TEXT bind) === RAW_PAYLOAD_HASH bind === response.raw_payload_hash`;
- the `PAYLOAD` bind is the **same string** as the `PAYLOAD_TEXT` bind, in the
  same statement (the invariant `SYNC_PAYLOAD_BYTES_MATCH` guards);
- `PAYLOAD_BYTES === Buffer.byteLength(text)`;
- the object store holds the **original `Uint8Array`**, not the decoded text.

The hash itself is unchanged and was already correct:
`createHash('sha256').update(rawBody)` over the request body, before any parse
(`src/server/sync/batch.ts`). Nothing reads a payload back out of a database to
hash it, on either backend. `tests/acceptance/04` still asserts the
key-order-sensitivity of the hash, now on both dialects.

---

## 6. Not verified, and cannot be, without a connection

In rough order of how much a first deploy should watch for them.

1. **Postgres accepts the generated `INSERT … SELECT … ON CONFLICT` shape.**
   Read by hand, generated for all six mappings, and checked for balanced
   parens/quotes and placeholder counts — but never parsed by Postgres. The
   parts I would look at first if the first deploy 500s: `INSERT INTO t AS t
   (cols) SELECT … FROM (subquery) s WHERE s.DEDUPE_RN = 1 ON CONFLICT (pk) DO
   UPDATE SET … WHERE guard`, and `jsonb_array_elements(<scalar subquery>) WITH
   ORDINALITY AS v(value, ord)` in the rebuild source.
2. **`CURRENT_USER::text` assigned to a `varchar(128)` column.** The DDL has the
   same dependency in its `DEFAULT CURRENT_USER` and the steward flagged it too;
   I cast explicitly rather than relying on the `name → varchar` assignment cast,
   which should make it strictly safer, but it is unparsed either way.
3. **Type coercion from the JSON projection into the column types** —
   `double precision → numeric(11,8)` for lat/lon, `text → date`, `text →
   timestamptz`, `text → boolean`. All are assignment-context casts and all are
   standard, but a payload carrying `""` where a date is expected would error on
   *both* backends and reject that entity type for the batch (retryable, so the
   outbox re-sends it forever until someone looks). No client produces that
   today; it is the shape of failure to recognise if a batch sticks.
4. **`MD5()` parity.** Both backends return lowercase 32-char hex, matching
   `defectId()` in TypeScript, so the deterministic defect id survives the
   `MERGE` → `ON CONFLICT` rewrite. Asserted structurally, never executed.
5. **Whether `RAW.SYNC_PAYLOAD`'s `octet_length` CHECK holds for a body that is
   not valid UTF-8.** `TextDecoder` would substitute U+FFFD and the byte count
   would disagree, failing the RAW insert and therefore the whole batch. Cannot
   happen through the current function (the handler `JSON.parse`s first), and
   Netlify Blobs holds the original bytes regardless.
6. **`CURATED.SAMPLE_POINT` has no `GEOG` column on Postgres** and the pipeline
   never writes one — but nothing has confirmed that the derivation `UPDATE`s
   match zero rows harmlessly on an empty database rather than erroring, because
   no statement has run.
7. **Everything downstream of an empty `CURATED.BOUNDARY_CACHE`** is unchanged
   by this pass and still blocks an end-to-end MVP, per the steward's §8.

---

## 7. Files touched

`git status --short`, verbatim (other lanes' files included; mine are marked):

```
 M netlify/functions/derive-batch-background.ts   <- mine
 M netlify/functions/ingest-commit.ts
 M netlify/functions/ingest-retire.ts
 M netlify/functions/ingest-validate.ts
 M netlify/functions/sync-batch.ts                <- mine
 M netlify/functions/sync-media-commit.ts         <- mine
 M src/ingest/commit/index.ts
 M src/ingest/retire/index.ts
 M src/ingest/validate/index.ts
 M src/server/derive/pipeline.ts                  <- mine
 M src/server/dev/mock-mode.ts
 M src/server/sync/batch.ts                       <- mine
 M src/server/sync/merge.ts                       <- mine
 M tests/acceptance/03-defect-in-a-minute.test.ts <- mine
 M tests/acceptance/04-replay-idempotency.test.ts <- mine
 M tests/acceptance/05-rebuild-from-raw.test.ts   <- mine
 M tests/unit/postgres-adapter.test.ts
?? .claude/fleet/reports/server-endpoints-netlify-db.md
?? src/ingest/commit/sql-postgres.ts
?? src/server/sync/dialect.ts                     <- mine
?? tests/acceptance/06-dual-backend-parity.test.ts <- mine
?? tests/acceptance/support/                      <- mine (fake-sql-client.ts)
?? tests/unit/ingest-postgres-port.test.ts
```

`integration/requests-a.md` is append-only and shared by design (§4 rule 4); it
does not appear above because `ingest-lane` and `server-endpoints` also appended
to it in this wave. This report is the only file I wrote under
`.claude/fleet/reports/`.

### Acceptance criteria 1–5 after the port

| Criterion | Test | State |
|---|---|---|
| 1 — seven-day drain | `01-seven-day-drain` | pass, untouched (device-side SQLite; no backend involvement) |
| 2 — force-quit ×20 | `02-force-quit` | pass, untouched. A retryable transport failure still leaves rows `in_flight` under the original `sync_batch_id` |
| 3 — one defect row each | `03-defect-in-a-minute` | pass. Same deterministic `MD5(subject\|code)` id across the `ON CONFLICT` rewrite |
| 4 — replay idempotency | `04-replay-idempotency` | pass **on both dialects**, plus a new case: the ack blob lost, the same batch written twice, byte-identical statement and binds, keyed on the primary key with the analyst guard intact |
| 5 — rebuild from RAW | `05-rebuild-from-raw` | pass **on both dialects**, plus arrival-order replay and the hash-anchor check in §5 |
