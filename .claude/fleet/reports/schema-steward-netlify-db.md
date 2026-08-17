# schema-steward — Netlify database / SQL port pass

**Tasks:** steward pass ahead of wave B (`sync-spine`, `ingest-lane` port their
queries against what is defined here). Additive backend port: MVP/UAT storage on a
Netlify database (Neon Postgres) behind a flag, Snowflake preserved as a
first-class backend.

**Gate:** `npm run typecheck && npm test` → **pass**.
`tsc --noEmit` clean. `vitest run` → **21 files, 217 passed, 1 skipped**
(baseline was 20 / 166 / 1; the delta is the 51 tests in the one new test file).
`npm run build` succeeds. `npm run lint` **cannot run** and could not before this
pass — ESLint 9.39 requires `eslint.config.js` and the repo has `.eslintrc.cjs`.
Not caused by and not fixed by this pass (`.eslintrc.cjs` is orchestrator-owned).

**I ran alone, so FLEET.md §4.5 does not apply — no concurrent-wave noise to
discount. Any failure here is mine.**

**No live database existed at any point.** Nothing in this pass has been executed
against Postgres. Verification is unit tests plus
`npx tsx tools/deploy-ddl.ts --target=postgres --dry-run`, and that is the honest
ceiling. The specific residual risks that only a live run can close are listed
under "Not verified, and cannot be" below.

---

## 0. Backward compatibility, in one line

**Every change is additive and backward-compatible. No existing call site needs to
change to keep working.** `StatementResult`, `ColumnMeta`, `ExecuteOptions`,
`BindValue`, `asObjects` and `scalar` moved from `src/shared/snowflake/client.ts`
into `src/shared/db/port.ts` and are **re-exported from their old location**, so
all 24 existing importers compile untouched (verified: `tsc --noEmit` clean, and
`tests/unit/snowflake-client.test.ts` imports `asObjects` from the old path and
still passes). `SnowflakeClient` gained two readonly members and now `implements
SqlClient`; it lost nothing.

One boundary note: **`src/server/env.ts` was granted to me for this pass only.**
It is unowned in FLEET.md §1 and should go back to unowned, or be assigned, after
this. Recorded here so the boundary is on the record.

---

## 1. The port interface

`sync-spine` and `ingest-lane` build against this. Full source with the reasoning
is `src/shared/db/port.ts`.

```ts
// src/shared/db/port.ts

export type SqlDialect = 'snowflake' | 'postgres';

export interface SqlCapabilities {
  /** ST_* / GEOGRAPHY / TO_GEOGRAPHY. FALSE on postgres — no PostGIS. */
  readonly geospatial: boolean;
  /** MERGE INTO … USING. false on postgres — use INSERT … ON CONFLICT. */
  readonly mergeInto: boolean;
  /** QUALIFY. false on postgres — window function in a subquery. */
  readonly qualify: boolean;
  /** VARIANT + PARSE_JSON + FLATTEN. false on postgres — ::jsonb, jsonb_array_elements. */
  readonly variantJson: boolean;
  /** executeMulti runs its statements in one transaction. true on both. */
  readonly multiStatementTransaction: boolean;
  /** A bare `?` is a bind placeholder. true on both (see the jsonb caveat below). */
  readonly positionalPlaceholders: boolean;
}

export interface ColumnMeta { name: string; type: string; nullable?: boolean }

export interface StatementResult {
  statementHandle: string;              // snowflake: server handle. postgres: client-side id
  columns: ColumnMeta[];
  rows: (string | null)[][];            // row-major, cells are STRINGS — unchanged
  numRowsInserted?: number;
  numRowsUpdated?: number;
}

export type BindValue = string | number | boolean | null | undefined | Date;

export interface ExecuteOptions {
  binds?: readonly BindValue[];
  timeoutSeconds?: number;      // snowflake only; ignored on postgres
  multiStatementCount?: number; // snowflake only; ignored on postgres
  requestId?: string;           // snowflake dedupes on it. POSTGRES HAS NO EQUIVALENT
  deadlineMs?: number;
}

export interface SqlClient {
  readonly dialect: SqlDialect;
  readonly capabilities: SqlCapabilities;
  execute(sql: string, options?: ExecuteOptions): Promise<StatementResult>;
  /**
   * One transaction. Binds are ONE FLAT positional array across all statements
   * (Snowflake's convention); the Postgres adapter splits it by counting
   * placeholders, so callers do not change. Only the LAST statement's result is
   * returned, on both backends — every current caller ignores it.
   */
  executeMulti(statements: readonly string[], options?: ExecuteOptions): Promise<StatementResult>;
}

// Unchanged, and the reason wave B is small. Both backends produce identical output.
export function asObjects<T = Record<string, string | null>>(r: StatementResult): T[];
export function scalar(r: StatementResult): string | null;

// NEW. The one place the two backends genuinely disagree — see §5.
export function asIsoTimestamp(value: string | null | undefined): string | null;

export const SNOWFLAKE_CAPABILITIES: SqlCapabilities; // all true
export const POSTGRES_CAPABILITIES: SqlCapabilities;  // geospatial/mergeInto/qualify/variantJson false
```

### What wave B actually does per call site

Change the type annotation, not the calls:

```ts
- import type { SnowflakeClient } from '../../shared/snowflake/client.js';
- export interface SyncBatchDeps { snowflake: SnowflakeClient; … }
+ import type { SqlClient } from '../../shared/db/port.js';
+ export interface SyncBatchDeps { snowflake: SqlClient; … }
```

`asObjects` / `scalar` imports, the `?` placeholders, and the bind arrays are all
unchanged. `tests/support/fake-snowflake.ts` needs no change either — its
`asClient()` uses `as unknown as SnowflakeClient`, which bypasses the structural
check. It also already satisfies `SqlClient` apart from the two new readonly
members, so widening it to `asClient(): SqlClient` is a two-line addition when
`sync-spine` wants it.

Selecting SQL per backend:

```ts
if (db.capabilities.mergeInto) { await db.execute(curatedMergeSql(...)); }
else                           { await db.execute(curatedUpsertSql(...)); }
```

### Where the two backends cannot agree, and I am not papering over it

| Thing | Snowflake | Postgres | Handling |
|---|---|---|---|
| **Timestamps** | epoch seconds as a string (`"1786838400.000000000"`) | ISO-8601 UTC (`"2026-08-16T00:00:00.000Z"`) | **No normalisation is faithful to both.** `asIsoTimestamp()` accepts either and is what any consumer that *parses* a timestamp read back out of the DB must use. Tested both directions. |
| **`requestId` dedup** | server-side; makes blind retry safe | none | The Neon HTTP driver gives no request idempotency. A retried write is safe here *only* because the writes are keyed upserts, which is why §2's constraints are load-bearing. The adapter's retryable set is therefore narrow: `40001 40P01 08* 53300 57P01 57P03` and transport faults. A `23505` is not retried. |
| **jsonb `?` `?|` `?&` operators** | n/a | unreachable | Indistinguishable from a placeholder to any lexer (node-postgres has the same limitation). The rewriter **throws** on `?|`/`?&` rather than mangling them. Use `jsonb_exists`, `jsonb_exists_any`, `jsonb_exists_all`. |
| **`numRowsInserted` / `numRowsUpdated`** | reported separately | one `rowCount` + a command tag | Attributed by command tag. Do not read more into these two numbers on Postgres than is there. |
| **`EDITDISTANCE`** | built in | needs `fuzzystrmatch` (`levenshtein`) or `pg_trgm` (`similarity`) | Only used inside the two guessed-name functions I must not touch (§4). **No extension is created** — I am not enabling one for a query whose table name is unconfirmed. |

Files: `src/shared/db/port.ts`, `src/shared/db/postgres/{client,neon,normalise,placeholders}.ts`.

---

## 2. Unique constraints available for `ON CONFLICT`

**Every `MERGE INTO` in the codebase keys on the target's primary key** — I
checked all nine call sites. So each one becomes
`INSERT … ON CONFLICT (<pk>) DO UPDATE SET …`, with the `WHEN MATCHED AND <guard>`
clause becoming a `WHERE <guard>` on the `DO UPDATE`. Snowflake does not enforce
primary keys; Postgres does, and these declarations are what make the upserts
possible.

| Table | `ON CONFLICT (…)` | Used today by |
|---|---|---|
| `CURATED.FIELD_VISIT` | `VISIT_ID` | `curatedMergeSql('field_visit')` |
| `CURATED.SAMPLE_POINT` | `SAMPLE_UID` | `curatedMergeSql('sample_point')` — carries the guard `COALESCE(REVIEW_STATE,'captured') <> 'accepted'` |
| `CURATED.SAMPLE_BAG` | `BAG_ID` | `curatedMergeSql('sample_bag')` |
| `CURATED.SAMPLE_CONDITION` | `CONDITION_ID` | `curatedMergeSql('sample_condition')` |
| `CURATED.MEDIA` | `MEDIA_ID` | `curatedMergeSql('media_meta')` |
| `CURATED.SAMPLE_DEFECT` | `DEFECT_ID` | `curatedMergeSql('local_defect')`, `raiseDefectFromQuery`, `writeFindings`, ingest `QUEUE_ITEMS_SQL` — all four; guard `RESOLUTION_STATE = 'open'` |
| `CURATED.SYNC_BATCH` | `SYNC_BATCH_ID` | `recordBatch` |
| `CURATED.PLAN_IMPORT` | `IMPORT_ID` | `PLAN_IMPORT_SQL` |
| `CURATED.PLAN_IMPORT_ROW` | `IMPORT_ROW_ID` | `PLAN_IMPORT_ROW_SQL` |
| `CURATED.SAMPLE_PLAN` | `PLAN_ID` | `SAMPLE_PLAN_SQL` |
| `CURATED.SAMPLE_PLAN_POINT` | `PLAN_POINT_ID` | `SAMPLE_PLAN_POINT_SQL` |
| `RAW.SYNC_PAYLOAD` | `RAW_PAYLOAD_HASH` | `persistRaw` — `INSERT … WHERE NOT EXISTS` becomes `ON CONFLICT … DO NOTHING` |
| `RAW.PLAN_IMPORT_FILE` | `CONTENT_HASH` | `RAW_FILE_SQL` — same |
| `CURATED.AUDIT_EVENT` | `EVENT_ID` | plain `INSERT`, no conflict target needed |
| `CURATED.DEVICE` | `DEVICE_ID` | plain `UPDATE` |
| `CURATED.DERIVATION_RUN` | `RUN_ID` | **new**; append-only log, one row per run — no upsert intended |
| `CURATED.BOUNDARY_CACHE` | `BOUNDARY_ID` | **new**; a cache loader will upsert on it |
| `CURATED.IMPORT_PROFILE` | `PROFILE_ID` **or** `(PERSON_REF, SURFACE)` | unused today. `(PERSON_REF, SURFACE)` is the natural key an upsert wants, so it is a `UNIQUE INDEX` as well |
| `REF.CONDITION_CODE` | `(CONDITION_CODE, CODE_SET_VERSION)` — **composite** | seeds |
| `REF.PROJECT_SAMPLING_SPEC` / `DEVIATION_REASON` / `DEFECT_CODE` / `DEFECT_FIELD_VISIBILITY` / `LAB` | their single id column | seeds |
| `RAW.MEDIA_UPLOAD_LOG` | **none, deliberately** | append-only log; a re-upload appends a second row, as it does on Snowflake |

**One index that is deliberately NOT unique:**
`IX_SAMPLE_BAG_BARCODE ON CURATED.SAMPLE_BAG(LAB_ID, BARCODE_RAW)`. A duplicate
`(LAB_ID, BARCODE_RAW)` is precisely what `BARCODE_DUPLICATE` detects. A unique
constraint there would reject the second bag instead of flagging it, and the
sample would be lost rather than queued.

**No foreign keys anywhere, deliberately.** Snowflake does not enforce
referential integrity and the sync contract is built on that: a child whose parent
has not arrived must land and become a defect, not be rejected. Contract §5 orders
parents before children *within* a batch, but a week of offline work splits them
across batches. FKs would turn "lands referentially sound even though the
warehouse does not enforce it" into a hard failure that loses a sample. Indexes
give the join performance; the defect rules are the integrity check.

Also on wave B: **`QUALIFY` appears once**, in `loadPriorPlans`
(`src/ingest/commit/index.ts:424`). `IX_SAMPLE_PLAN_PERIOD_BOUNDARY
(PERIOD_CODE, BOUNDARY_ID, PLAN_VERSION DESC)` exists to keep the
window-function-in-a-subquery rewrite cheap.

---

## 3. Geospatial absence, and the `boundary_id` decision

### The failure being designed against

`POINT_OUTSIDE_BOUNDARY` (from `ST_WITHIN`) and `OFFSET_EXCEEDED_NO_REASON` (from
`OFFSET_FROM_PLAN_M`, i.e. `ST_DISTANCE`) are both computations over geography. If
neither runs and nothing records that, the pipeline completes, no defect is
raised, and every sample reads `REVIEW_STATE = 'screened'`. The offset rule
already fails **silently by construction** —
`src/server/defects/rules/offset-exceeded-no-reason.ts:23` is
`if (sample.offset_from_plan_m === null … ) continue;`. A tester concludes defect
detection works; an auditor in 2029 cannot tell an unchecked sample from a
checked-and-clean one.

### The design: three parts, one of which has teeth

**1 · `SAMPLE_POINT.GEO_DERIVATION_STATE`**, `NOT NULL DEFAULT 'pending'`, with a
CHECK on a closed domain. Every row states which geographic derivation it received:

| value | meaning |
|---|---|
| `pending` | landed; the geography step has not run. The default |
| `derived_geodesic` | full `ST_*` on a geospatial backend. The production answer |
| `derived_planar` | app-side GeoJSON ray-cast + haversine. **Reserved; nothing sets it.** In the domain now so lifting the deferral is a code change and not a migration, and so those rows are never mistaken for the geodesic answer — planar containment and geodesic `ST_WITHIN` disagree at boundary edges |
| `deferred_no_geospatial` | the backend has no geospatial. Explicitly **not checked** |
| `invalid_geometry` | checked, and the coordinate is bad. Deliberately *not* counted as verified: a bad coordinate means containment and offset were never evaluated either |

**2 · `CURATED.DERIVATION_RUN`** — new, append-only, one row per pipeline run per
batch: `BACKEND`, `GEO_CAPABILITY ('full'|'none')`, `STEPS_COMPLETED`,
**`STEPS_SKIPPED`**, plus the counts. Batch-level, so the question survives a later
re-derivation that overwrites the per-row state. An empty `STEPS_SKIPPED` on a run
with `GEO_CAPABILITY='none'` is a pipeline bug, not a clean run.

**3 · A CHECK constraint that refuses the lie.**

```sql
CONSTRAINT SAMPLE_POINT_SCREENED_REQUIRES_GEO CHECK (
    REVIEW_STATE <> 'screened'
    OR GEO_DERIVATION_STATE IN ('derived_geodesic', 'derived_planar')
)
```

`screened` means *every* server rule ran and found nothing. On a backend without
geospatial that sentence is false, so the write is **refused** and the clean
terminal state is the new value `screened_partial`. The Postgres path *cannot*
record a full pass it did not perform. It fails at the write, in a test, on day
one — rather than in an audit in three years.

**Wave B: this will break derivation step 8 on Postgres unless you use
`cleanReviewStateFor()`.** That is intentional and it is the loudness. Use
`src/shared/db/geo-assurance.ts`:

```ts
import { cleanReviewStateFor, geoStateForCapability } from '../../shared/db/geo-assurance.js';
// step 3/4: stamp what actually happened
const geoState = geoStateForCapability(db.capabilities.geospatial);
// step 8: 'screened' only if the geographic checks ran, else 'screened_partial'
const clean = cleanReviewStateFor(geoState);
```

`REVIEW_STATE` gains one value, `screened_partial`. I checked every consumer of
`review_state`: `merge.ts:111` (`<> 'accepted'`, unaffected),
`pipeline.ts:149/158/165` (the `CASE` and the count query — wave B's to update),
`snowflake_sampling_v01.sql:462` (`V_SAMPLE_REVIEW_QUEUE`, passes it through),
`tests/acceptance/03` and `05` (assert on SQL text, not on values). Nothing in the
app or the contract enumerates the domain, so this is additive.

**4 · `CURATED.V_SAMPLE_GEO_ASSURANCE`** — the auditor's one query.
`ASSURANCE_VERDICT` is a single column that never says clean about an unchecked
sample: `clean_verified` / **`clean_geo_unverified`** / `needs_review` /
`bad_coordinate` / `awaiting_derivation` / `analyst_accepted` /
`analyst_rejected`. Plus `GEO_CHECKED`, `OUTSIDE_ALL_BOUNDARIES` and
`BOUNDARY_UNKNOWN` as booleans, and `IX_SAMPLE_POINT_GEO_STATE` so "how many
samples were never boundary-checked" is one cheap query.

**I did not add a defect code for this, and that is a decision.** A defect says
"this sample has a problem"; not-checked is a pipeline capability gap that applies
to 100% of rows on this backend. The right instrument for a condition every row
shares is a column and a batch-level record, not a per-row queue item that would
be pure noise. (It is also consistent with ownership — `src/shared/codes/**` is
`spec-transcriber`'s and I do not write there.)

### `boundary_id`: NULLABLE, no sentinel. The open board question, settled.

`.claude/fleet/TASK_BOARD.md` and `CLAUDE.md` both carry *"Nullable
`SAMPLE_POINT.boundary_id` vs a `BOUNDARY_UNKNOWN` sentinel"* as unresolved.
Deferring geospatial means every sample on this backend has no boundary, so it
cannot stay open. **Nullable, no sentinel.** Reasoning:

1. **There are two different unknowns and a sentinel can only encode one.**
   "Checked; inside no active boundary" is a finding worth acting on — it is
   usually a boundary problem, which is why `POINT_OUTSIDE_BOUNDARY` is
   `blocking` and field-visible. "Never checked" is not a finding at all. One
   sentinel value makes them the same row. `NULL` + `GEO_DERIVATION_STATE`
   distinguishes them, and it turns `NULL`-with-`derived_geodesic` into a
   *positive assertion* rather than an absence — which is what the sentinel was
   wanted for in the first place.
2. **A `NOT NULL` column forces every writer to know about the sentinel.**
   Forgetting it is a constraint violation on the sync path, i.e. a rejected
   sample from a crew that is 200 miles away and offline. A NULL that is wrong is
   recoverable by re-deriving; a rejected record needs the crew back.
3. **A sentinel is a fake row in a real dimension.** `BOUNDARY_UNKNOWN` in
   `BOUNDARY_CACHE` means every `GROUP BY boundary_id` silently grows a bucket
   that looks like a place, and every acreage or completion aggregate has to
   remember to exclude it. Aggregates that must remember to exclude something
   eventually don't.
4. It also matches what the code already assumes — `RuleSample.boundary_id` is
   `string | null` and the pipeline's step 4 is `WHERE sp.BOUNDARY_ID IS NULL`.

The same reasoning applies to `OFFSET_FROM_PLAN_M`, `BEARING_FROM_PLAN_DEG` and
`TRS_CANONICAL`: nullable, with `GEO_DERIVATION_STATE` carrying the meaning.

### What the deferral does *not* cost

**`/ingest/validate`'s point-in-polygon is unaffected.** It already runs in pure
TypeScript over GeoJSON (`src/shared/geo/point-in-polygon.ts`, called from
`src/ingest/validate/index.ts`), and `BOUNDARY_CACHE` stores GeoJSON plus
**precomputed** centroid and bbox — so `ST_ASGEOJSON`, `ST_CENTROID`, `ST_X/Y` and
the `ST_XMIN..YMAX` bounds have no caller left. Ingest validation is fully
functional on this backend.

**`GEOG_VALID` survives too.** On Postgres it reduces to "lat/lon present and in
range", which is arithmetic. So `GEOM_INVALID` still fires on every backend —
unlike the two rules above.

**The cheapest route out of deferral** is app-side derivation, because
`src/shared/geo/` already has both primitives (`pointInPolygon`,
`haversineMetres`, `bearingDegrees`). I did **not** build it: it is a real design
decision with accuracy consequences (geodesic vs planar containment, geodesic vs
haversine distance) and the user's call was to defer. If it is taken later, the
state to write is `derived_planar`, not `derived_geodesic` — the domain already
has the slot.

---

## 4. RAW content-hash reproducibility

`tests/acceptance/05-rebuild-from-raw.test.ts` asserts the curated layer is
rebuildable from RAW. Two things had to be true and both now are.

**The hash is already over the original bytes and I did not change that.**
`handleSyncBatch` computes `createHash('sha256').update(rawBody)` on the request
body **before anything is parsed** (`src/server/sync/batch.ts:63`, with the
`@param rawBody` note explaining why it is not over a re-serialisation). That is
backend-independent.

**What I added is that the bytes stay recoverable from the database.**
`RAW.SYNC_PAYLOAD` in the Postgres DDL has:

```sql
PAYLOAD_TEXT  text  NOT NULL,   -- VERBATIM, as received. The hash anchor.
PAYLOAD       jsonb NOT NULL,   -- queryable projection of the above
PAYLOAD_BYTES numeric(12,0),
CONSTRAINT SYNC_PAYLOAD_BYTES_MATCH CHECK (
    PAYLOAD_BYTES IS NULL OR octet_length(PAYLOAD_TEXT) = PAYLOAD_BYTES
)
```

Reasoning, stated plainly because this is the part that would silently break
reproducibility:

- jsonb normalises key order and drops duplicate keys. **So does Snowflake's
  `VARIANT`** — the Snowflake row was never byte-faithful either. Re-serialising
  `PAYLOAD` on *either* backend produces bytes that do not hash to
  `RAW_PAYLOAD_HASH`.
- `PAYLOAD_TEXT` makes `sha256(PAYLOAD_TEXT) = RAW_PAYLOAD_HASH` a **checkable
  statement** rather than an article of faith, without a Netlify Blobs round trip.
  This is strictly better than the Snowflake table, not merely equivalent.
- The invariant is: both columns are written from the **same bind, in the same
  statement**, and neither is ever updated. The `octet_length` CHECK catches a
  truncated write — the failure that would otherwise show up as an inexplicable
  hash mismatch months later.
- `new TextDecoder().decode(rawBody)` re-encodes to the identical bytes for valid
  UTF-8, which is the same assumption the Snowflake path already makes.
- Netlify Blobs (`rawPayloadKey(payloadHash)`) remains the authoritative byte
  store. Unchanged.

**Same treatment for the ingest row anchor.** `PLAN_IMPORT_ROW.RAW_VALUES_JSON` is
"verbatim, pre-mapping" — but jsonb (like `VARIANT`) is an unordered object, so it
loses spreadsheet **column order**. `RAW_VALUES_TEXT text` is added beside it; the
commit path already holds the verbatim string (`JSON.stringify(row.raw_values)`),
so preserving it costs nothing. Addendum §5 flags this column as the
reproducibility anchor *and* as a retention question; it is now actually faithful.

**Wave B, `rebuildCuratedFromRaw`:** read `PAYLOAD` (jsonb) for the rebuild — it
is the same normalised value Snowflake's `VARIANT` gives, so the rebuild is
identical on both backends. Read `PAYLOAD_TEXT` only to *verify* the hash. Do not
hash `PAYLOAD`.

---

## 5. The backend flag

`src/server/env.ts`. Three-way, resolved once per cold start.

```ts
export type SqlBackend = 'snowflake' | 'postgres' | 'mock';
export function sqlBackend(): SqlBackend;
export function sqlClient(): SqlClient;   // ← what server code should depend on
export function snowflake(): SnowflakeClient;  // unchanged, still throws without creds
export function postgres(): PostgresClient;
export function databaseUrl(): string;          // required('NETLIFY_DATABASE_URL')
export function migrationDatabaseUrl(): string;  // prefers …_UNPOOLED
```

Resolution order:

1. `SQL_BACKEND`, if set. Explicit always wins. An unrecognised value throws.
2. `MOCK_SNOWFLAKE=1` → `mock`. Preserves the existing local-dev escape hatch.
3. **Both `NETLIFY_DATABASE_URL` and `SNOWFLAKE_ACCOUNT` present → throws**,
   naming `SQL_BACKEND`. Netlify injects its database URL into *every* deploy, so
   the day Snowflake credentials land both will be set — and picking one silently
   is how a production deploy ends up writing to the UAT database. One env var,
   and this is the moment to require it.
4. One of the two → that backend.
5. Neither → `mock`, matching `isMockMode()`'s current bare-checkout default so
   the test suite and `netlify dev` still run with nothing configured.

**The fail-loudly property is preserved per backend, as asked.** `snowflake()` is
byte-for-byte unchanged and still throws `missing required environment variable
SNOWFLAKE_ACCOUNT`. Selecting Postgres requires no Snowflake variable. Selecting
Postgres without `NETLIFY_DATABASE_URL` throws with the variable named.
`sqlClient()` on `mock` **throws** rather than returning a silently-empty client —
a caller that supports mock mode checks `isMockMode()` and serves fixtures, as
A2/C7/C8/C12 already do; it does not ask for a client it cannot have.

`auditWriter()` now throws a named error on any backend other than Snowflake,
because `AuditWriter` is typed against `SnowflakeClient` and the auth surface is
out of scope. Better than surfacing as "missing SNOWFLAKE_ACCOUNT" three layers
down. `/ingest/commit` and `/ingest/retire` write `CURATED.AUDIT_EVENT` through
their own statements, so the ingest audit trail is unaffected.

### ⚠ `isMockMode()` is now wrong, and it is not my file

`src/server/dev/mock-mode.ts` (owner: `server-endpoints`) reads
`MOCK_SNOWFLAKE === '1' || !process.env.SNOWFLAKE_ACCOUNT`. **With the Postgres
backend selected and no Snowflake credentials — which is the entire MVP
configuration — the second clause is true, so every endpoint that consults it
serves fixtures and the Netlify database is never reached.** Requested one-line
fix (`return sqlBackend() === 'mock';`) is in `integration/requests-a.md`. I did
not edit the file. There is an executable note documenting the hazard at
`tests/unit/postgres-adapter.test.ts` → *"the mock-mode composition hazard"*; it
asserts the current wrong behaviour, so it starts failing the moment the fix
lands, which is the signal to delete it.

---

## 6. The migration runner

`src/shared/db/migrate-postgres.ts`, entrypoint `tools/deploy-ddl.ts`.

**The command to wire into the Netlify build:**

```
npx tsx tools/deploy-ddl.ts --target=postgres
```

I did **not** edit `netlify.toml` or `package.json` (§4 rule 3). Suggested script
name if you want one: `"db:migrate": "tsx tools/deploy-ddl.ts --target=postgres"`.
`--target` defaults to `snowflake`, so every pre-existing invocation still means
what it meant.

| Requirement | How |
|---|---|
| Every statement idempotent | 77 statements: `CREATE … IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `CREATE OR REPLACE VIEW`, `INSERT … ON CONFLICT DO NOTHING`, and 3 `DO $$` assertions. A test asserts *every* statement matches one of those forms. Running it twice is indistinguishable from once |
| Advisory lock | `SELECT pg_advisory_xact_lock(0x5643, 0x4744)` as the **first statement of the migration transaction**. The **transactional** variant, not by accident: Neon's HTTP driver is stateless, so a session-scoped `pg_advisory_lock` would be released the instant its one-query HTTP session ended — a lock that looks like a lock and holds nothing. A second runner waits |
| Ledger | `META.SCHEMA_MIGRATION (MIGRATION_ID pk, CONTENT_SHA256, STATEMENT_COUNT, FIRST_APPLIED_TS, APPLIED_TS, APPLIED_RUN_ID, APPLY_COUNT)`. Created by the runner, not by the DDL file it gates. A file whose hash matches is **skipped** — that is the every-deploy fast path. A file whose hash changed is re-applied and reported as `content_changed` |
| Fail loudly without the URL | `required('NETLIFY_DATABASE_URL')`. Verified: exits 1 with the variable named |
| `--dry-run` still the ceiling | `--target=postgres --dry-run` prints the plan including the lock and the ledger writes, **opens no connection**, and says so — including that it could not read the ledger, so the plan shown is a first-deploy plan. Exits 0 |

**Bonus from the design:** because Postgres DDL is transactional and the whole
migration is one transaction, **a failure rolls the schema back** rather than
leaving half of it. That is strictly better than the Snowflake runner's
statement-at-a-time behaviour.

**Honest limit.** The pending set is computed *before* the lock, because the HTTP
driver's transactions are non-interactive — you submit a fixed list and cannot
branch mid-transaction. So a runner that loses the race re-executes idempotent
DDL rather than skipping it. Harmless, and the `APPLIED_RUN_ID` stamp means it
still *reports* the truth: it says it applied nothing, because it did not write
the rows. Tested.

### Should a failed migration fail the deploy? Yes.

`process.exitCode = 1`. Verified.

I agree with you and the reason is specific to this product rather than general
hygiene. The schema is a hard precondition for every function here, and the
client that hits those functions is **an offline outbox with a week of a crew's
work in it and automatic retry**. A green deploy behind an empty schema returns
500s that the outbox treats as transient and retries for days, while the app UI
shows "syncing" — so the people who would notice are told nothing, and the
people who could fix it are told nothing either. There is no fast feedback loop
to catch it, which is the property that makes soft-failing acceptable elsewhere.
A red deploy names the failing statement and keeps the previous deploy serving.
The asymmetry is not close.

Two consequences worth accepting explicitly: the first deploy against a fresh
database will fail if `NETLIFY_DATABASE_URL` is not yet wired (correct — that is
the misconfiguration you want surfaced at minute one), and a migration that fails
mid-season blocks the deploy rather than the sync (also correct — the functions
already deployed keep running against the old schema).

---

## 7. What I deliberately left out of the DDL

`postgres_sampling_v01.sql`, 77 statements, 20 tables + 6 views + 6 seeded
reference tables.

| Left out | Why |
|---|---|
| **`CURATED.INGEST_ACCESS_TOKEN`** | The auth surface. Out of scope by instruction; keeps serving the mock/fixture path. `src/shared/auth/token.ts` queries it and will fail on this backend — expected, and the reason `auditWriter()` throws with a named error |
| **`CURATED.V_SAMPLE_REVIEW_QUEUE`** | The analyst queue. Out of scope by instruction. `CURATED.SAMPLE_DEFECT` itself **is** included, because derive writes it |
| **`CURATED.LAB_RESULT`, `CURATED.PROPERTY`, `V_LAB_RESULT_ENTITY`, `V_BAG_LAB_MATCH`** | The lab join, and the entity model that lives in `VCH_GEO`. Not sync/derive/ingest, and there is nothing to pass through to from a Netlify database |
| **`CURATED.SHIPMENT`, `CURATED.SHIPMENT_BAG`** | Custody stubs. No v1 UI, no code path, no v1 consumer |
| **`SP_RESOLVE_SAMPLE_BOUNDARY`, `CURATED.V_SAMPLE_PLAN_OFFSET`** | `ST_WITHIN` and `ST_DISTANCE`. Deferred with the geospatial |
| **All `GEOGRAPHY` columns** — `SAMPLE_POINT.GEOG`, `SAMPLE_PLAN_POINT.PLANNED_GEOG`, `BOUNDARY.GEOG` | No PostGIS. `LAT`/`LON` survive on every one of them, so lifting the deferral needs no migration. A test asserts no `ST_*` call and no PostGIS type in any executable statement |
| **`CREATE EXTENSION` of any kind** | Nothing in scope needs one. `pg_trgm`/`fuzzystrmatch` would be needed only by the guessed-name match queries in §8, and I am not enabling an extension for a query whose table name is unconfirmed |
| **Foreign keys** | §2, and it is a design decision rather than an omission |

**Added that has no Snowflake counterpart:** `CURATED.BOUNDARY_CACHE`,
`CURATED.DERIVATION_RUN`, `CURATED.V_SAMPLE_GEO_ASSURANCE`,
`SAMPLE_POINT.GEO_DERIVATION_STATE` + `GEO_DERIVED_TS`,
`RAW.SYNC_PAYLOAD.PAYLOAD_TEXT`, `PLAN_IMPORT_ROW.RAW_VALUES_TEXT`,
`META.SCHEMA_MIGRATION`.

**Included even though nothing uses it yet:** `CURATED.IMPORT_PROFILE`. It is an
ingest table and ingest is in scope; C13 (the ingest tutorial branch) is its first
consumer.

### Type mapping, and the one deliberate divergence

`VARCHAR(n)→varchar(n)`, `NUMBER(p,s)→numeric(p,s)`, `BOOLEAN→boolean`,
`VARIANT→jsonb`, `ARRAY→jsonb` (not `text[]` — consumers `JSON.parse` these
columns, and jsonb reproduces Snowflake's JSON-text rendering exactly).
Identifiers are written UPPERCASE and **never quoted** so Postgres folds them and
`CURATED.SAMPLE_POINT` in a query resolves; the file says never to quote one.

**`TIMESTAMP_NTZ → timestamptz`, deliberately not `timestamp`.** `timestamp` is
the literal counterpart and the wrong choice: every value this app writes is an
ISO-8601 string with a `Z`, and a zone-less column parses that by silently
discarding the offset. For an application whose entire purpose is capture
provenance across time zones, an ambiguous timestamp column is the one thing not
to have. `CAPTURED_TS_UTC_OFFSET` still carries the device's local offset
separately, so nothing is lost. This is the divergence that makes
`asIsoTimestamp()` necessary (§1).

### `REF.DEFECT_FIELD_VISIBILITY` — the seed is there, and it found a real bug

Checked as my agent file requires. The table is fresh on this backend, so the seed
had to be written, and I generated §9d/§9e from `src/shared/codes/index.ts` — the
authority the running code uses — rather than copying the Snowflake seeds. That
surfaced **live drift in the Snowflake reference data** (not mine to fix; the
`snowflake_*.sql` files are not to be edited):

- **`snowflake_bootstrap_v01.sql` §8d/§8e seed `OFFSET_WITHOUT_REASON`. The code
  actually emitted is `OFFSET_EXCEEDED_NO_REASON`** (`codes/index.ts:25`,
  `offset-exceeded-no-reason.ts:15`). So the seed contains a code nothing raises
  and lacks the one that is raised.
- **`GEOM_INVALID` is seeded nowhere**, but `derive/pipeline.ts:65` raises it.
- Consequence on Snowflake: both codes get no `REF.DEFECT_CODE` row and no
  `REF.DEFECT_FIELD_VISIBILITY` row, so `COALESCE(vis.VISIBLE_TO_FIELD, FALSE)`
  hides them. Both happen to be office-only in `codes/index.ts`, so nothing is
  currently *visibly* broken — but the reference tables are incomplete and
  `OFFSET_WITHOUT_REASON` is seeded `VISIBLE_TO_FIELD = TRUE` for a code that
  will never be raised.
- **Bootstrap §9e would not catch it.** It joins `DEFECT_CODE → VISIBILITY`, and
  neither code is in `DEFECT_CODE`, so it returns zero and the gap is invisible.

The Postgres file seeds **all 17 codes** from `codes/index.ts` with the severities
from `DEFAULT_SEVERITY` and the visibility from `VISIBLE_TO_FIELD`, and there is a
test that fails if any `DEFECT_CODE` value is missing from either seed. It also
uses `ON CONFLICT DO NOTHING` per row rather than the Snowflake seeds'
`WHERE NOT EXISTS (SELECT 1 FROM …)` block guard — that guard skips the *whole
block* if any row is present, which is exactly why codes introduced later never
got added.

**And the v02 "shipped empty" failure is now a deploy-time assertion**, not a
`SELECT` nobody reads:

```sql
DO $$ … RAISE EXCEPTION 'REF.DEFECT_FIELD_VISIBILITY has no decision for: %. '
  'Every defect without a row here is invisible to the field, silently.', missing; … END $$;
```

Three such assertions: visibility completeness, REF tables not empty, and no
`screened`-without-derived-geo rows. They `RAISE`, so they fail the migration and
the deploy. Informational queries are kept in §11 of the file but **commented**,
so they cannot be mistaken for checks.

---

## 8. Stopped, and did not guess

- **The three known schema-name gaps are untouched, as instructed.**
  `boundaryIdsForCrew` (no `crew_org_id` → boundary assignment table),
  `loadAccessContacts` (no `CURATED.ACCESS_CONTACT`),
  `findOperationCandidates` / `findContactCandidates` (no `CURATED.OPERATION` /
  `CURATED.PERSON`). No Postgres table was created for any of them. They still
  need a human; they are wave 4.
- **`CURATED.BOUNDARY_CACHE` is where the entity-model naming question lands on
  this backend, and it is one place** — the same discipline as
  `snowflake_v03_entity_compat.sql`. `CURATED.V_BOUNDARY_ENTITY` is a view over
  it with the v03 column list minus `GEOG` plus the precomputed geometry
  summaries, so every consumer goes through the view. Whether `VCH_GEO` calls it
  `BOUNDARY`/`PROPERTY` (Phase 1) or `FACT_BORDER` (legacy) is a question for the
  **loader that fills the cache — and that loader is not written.** I did not
  write it, because writing it requires guessing the source names, which is
  exactly the guess I am told not to make. Blocked on the same session against
  `VCH_GEO` that pre-work item 5 unblocks.
- **⚠ Consequence, and it is a genuine gap in the MVP path:** with
  `BOUNDARY_CACHE` empty, `/ingest/validate` resolves every row to no boundary
  and blocks the whole file. **The Postgres backend is not usable end-to-end
  until something populates that table.** The nearest unblocked option is loading
  it from `fixtures/` for UAT — `SOURCE_KIND` exists so `'fixture'` rows are
  distinguishable from real exported geometry — but that is an ingest/fixtures
  decision and neither path is mine. Needs a task on the board.
- **`derived_planar` is reserved and unset.** I did not implement app-side
  geospatial derivation. It is buildable today from `src/shared/geo/**` but it is
  a real accuracy decision and the call was to defer.
- **I did not add a `GEO_CHECK_DEFERRED` defect code** — reasoning in §3, and
  `src/shared/codes/**` is not mine regardless.
- **A12 (Snowflake DDL deploy) remains blocked** on the service user, key pair
  and network policy — pre-work item 5. `--target=snowflake --dry-run` runs clean
  (25 + 25 + 5 statements) and now prints "DRY RUN complete. Nothing was applied
  and no warehouse was contacted." rather than "deploy complete", so a dry run
  cannot be misread as a deploy. **Nothing was deployed and no deploy was
  simulated.**
- **Not verified, and cannot be, without a live database.** Listing these because
  they are the things a first deploy will surface: (a) whether every statement
  parses — checked for balanced quotes/parens/`$$` across all 77 and reviewed by
  hand, but not parsed by Postgres; (b) whether the Neon HTTP `transaction()`
  accepts 79 statements including 3 `DO $$` blocks in one request; (c) whether
  the `plpgsql` assertions behave as written; (d) `DEFAULT CURRENT_USER` on a
  `varchar` column, which relies on the `name → text` assignment cast. If (b)
  turns out to be limited, the fix is to run the migration in per-file
  transactions — the lock and ledger design does not change.

---

## 9. Needs from another agent

Both appended to `integration/requests-a.md`.

1. **`server-endpoints`** — the `isMockMode()` fix in §5. **This blocks the
   Postgres backend from being reachable at all**, so it should land before or
   with wave B, not after.
2. **Whoever owns `src/shared/auth/audit.ts`** — widen
   `AuditWriterOptions.snowflake` to `SqlClient` when the auth surface is ported.
   Not urgent. **`src/shared/auth/**` is unowned in FLEET.md §1 and needs an
   owner assigned** — it is the second unowned path this pass has run into, after
   `src/server/env.ts`.

Orchestrator-owned items I could not do:

3. Wire `npx tsx tools/deploy-ddl.ts --target=postgres` as a Netlify build step
   (`netlify.toml`), and optionally a `db:migrate` script (`package.json`).
4. `npm run lint` is broken repo-wide (ESLint 9 flat-config migration). Predates
   this pass.
5. Board updates: `boundary_id` is **decided** (nullable, no sentinel — §3);
   `REVIEW_STATE` gains `screened_partial`; a new task is needed for the
   `BOUNDARY_CACHE` loader; the `OFFSET_WITHOUT_REASON` / `GEOM_INVALID`
   reference-data drift (§7) belongs in wave 4 with A12.
6. **No dependency was added, removed or upgraded.** `@neondatabase/serverless`
   was already installed and is now used. I did not need another one.

---

## 10. Files touched

`git status --short`, verbatim:

```
 M integration/requests-a.md
 M src/server/env.ts
 M src/shared/snowflake/client.ts
 M tools/deploy-ddl.ts
?? .claude/fleet/reports/schema-steward-netlify-db.md
?? postgres_sampling_v01.sql
?? src/shared/db/geo-assurance.ts
?? src/shared/db/migrate-postgres.ts
?? src/shared/db/port.ts
?? src/shared/db/postgres/
?? src/shared/db/sql-statements.ts
?? tests/unit/postgres-adapter.test.ts
```

`src/shared/db/postgres/` = `client.ts`, `neon.ts`, `normalise.ts`,
`placeholders.ts`. `integration/requests-a.md` is append-only and shared by
design (§4 rule 4); this report is the only file written under
`.claude/fleet/reports/`. **No file was written outside the paths granted for
this pass, and no git command that writes was run.**

| File | What it does |
|---|---|
| `src/shared/db/port.ts` | The port: `SqlClient`, `SqlCapabilities`, `StatementResult`, `asObjects`, `scalar`, `asIsoTimestamp` |
| `src/shared/db/postgres/placeholders.ts` | `?` → `$n` respecting literals, quoted identifiers, comments and `$tag$` bodies; flat-bind splitting for `executeMulti` |
| `src/shared/db/postgres/normalise.ts` | Postgres value → the string-row convention. **The subtlest file in the pass** |
| `src/shared/db/postgres/client.ts` | `PostgresClient implements SqlClient`, injected driver, bounded retry |
| `src/shared/db/postgres/neon.ts` | The real driver: Neon HTTP, `arrayMode + fullResults`, `transaction()` |
| `src/shared/db/geo-assurance.ts` | `GEO_DERIVATION_STATE`, `REVIEW_STATE`, `cleanReviewStateFor`, `isGeoVerified` — the TS half of the CHECK constraints |
| `src/shared/db/migrate-postgres.ts` | Idempotent, advisory-locked, ledgered migration runner |
| `src/shared/db/sql-statements.ts` | `splitStatements` moved out of `tools/` so both runners share it; re-exported from `tools/deploy-ddl.ts` so the existing test import is unchanged |
| `postgres_sampling_v01.sql` | The Postgres DDL. 77 statements |
| `src/server/env.ts` | `sqlBackend()`, `sqlClient()`, `postgres()`, `databaseUrl()`, `migrationDatabaseUrl()`; `snowflake()` unchanged |
| `src/shared/snowflake/client.ts` | `implements SqlClient`, `dialect`, `capabilities`; shared types re-exported from the port |
| `tools/deploy-ddl.ts` | `--target=snowflake\|postgres`, `--dry-run` on both, exit 1 on failure |
| `tests/unit/postgres-adapter.test.ts` | 51 tests. `tests/unit/` is unowned except `defect-rules*.test.ts`; **I added one new file and edited no existing test** |
