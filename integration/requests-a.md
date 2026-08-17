# Cross-lane requests → Lane A

Concurrent build plan §5 rule 3. **Append only** — one file per lane so two
instances appending never conflict. A change you need in Lane A's paths goes
here; it does not go in a direct edit to those paths.

Format: date · who is asking · what · why it matters.

---

**2026-08-17 · Sonnet lane (F0.8/A2/C7/C8/C12) ·** Three schema gaps hit while
building A2 (`assignments-bundle.ts`) and C8 (`match.ts`) — flagging rather
than guessing wrong, same discipline as `snowflake_v03_entity_compat.sql`:

1. **No `crew_org_id` → boundary assignment table exists.** A2's
   `boundaryIdsForCrew()` currently falls back to "every boundary with a
   released plan for the period," ignoring `crew_org_id` entirely (plan v02
   §13 open question 5). Fine for a one-or-two-crew pilot, wrong once a
   second crew exists. Needs a real table or a view once the Phase 1 entity
   model settles.
2. **No `CURATED.ACCESS_CONTACT` table.** `loadAccessContacts()` queries a
   guessed name and swallows the failure to an empty list rather than
   guessing wrong and breaking the bundle. Contract §2 access contacts are
   the entire BYOD data-exposure story for the sampler, so this is worth
   confirming before the pilot, not after.
3. **No `CURATED.OPERATION` / `CURATED.PERSON` tables.** C8's
   `findOperationCandidates` / `findContactCandidates`
   (`src/ingest/validate/match.ts`) query guessed names, following
   `PLAN_INGEST_SPEC_v01.md` §3's `OPERATION.legal_name` reference. Same
   category of gap as #1/#2 — isolated to two functions, one edit each once
   the live names are known.

None of these block local dev or tests — `MOCK_SNOWFLAKE=1` (or no
`SNOWFLAKE_ACCOUNT`) routes A2/C7/C8/C12 through F0.7 fixtures instead
(`src/server/dev/mock-mode.ts`, `fixtures.ts`). They block a real pilot
deploy. See `SONNET_TASKS_STATUS.md` for the full rundown.

---

**2026-08-17 · schema-steward (Netlify database / SQL port pass) ·** Two
one-line changes needed in paths I do not own. Both are recorded in
`.claude/fleet/reports/schema-steward-netlify-db.md`; this is the queue copy.

1. **`src/server/dev/mock-mode.ts` — `isMockMode()` is now wrong when the
   Postgres backend is selected.** It reads
   `MOCK_SNOWFLAKE === '1' || !process.env.SNOWFLAKE_ACCOUNT`. With
   `SQL_BACKEND=postgres` (or `NETLIFY_DATABASE_URL` set and no Snowflake
   credentials, which is the whole MVP configuration) the second clause is true,
   so every endpoint that consults it serves fixtures and **the Netlify database
   is never reached**. Requested replacement, which subsumes the old behaviour
   including the `MOCK_SNOWFLAKE=1` escape hatch and the bare-checkout default:

   ```ts
   import { sqlBackend } from '../env.js';
   export function isMockMode(): boolean {
     return sqlBackend() === 'mock';
   }
   ```

   Owner: `server-endpoints` (`src/server/dev/**`). There is a failing-on-purpose
   test documenting the hazard at
   `tests/unit/postgres-adapter.test.ts` → *"the mock-mode composition hazard"*;
   it asserts the CURRENT (wrong) behaviour, so it will start failing the moment
   this is fixed. Delete that test in the same change.

2. **`src/shared/auth/audit.ts` — `AuditWriterOptions.snowflake` should widen to
   `SqlClient`.** One line:

   ```ts
   import type { SqlClient } from '../db/port.js';
   export interface AuditWriterOptions { snowflake: SqlClient; ipHashSalt: string; }
   ```

   Not urgent: the auth surface is deliberately out of scope for the Netlify
   database and keeps serving the mock/fixture path, and `/ingest/commit` and
   `/ingest/retire` write `CURATED.AUDIT_EVENT` through their own statements
   rather than through `AuditWriter`. Until it is widened, `auditWriter()` in
   `src/server/env.ts` throws a named error on any backend other than Snowflake
   rather than surfacing as "missing SNOWFLAKE_ACCOUNT" three layers down.
   `src/shared/auth/**` is unowned in FLEET.md §1 — it needs an owner assigned.

---

**2026-08-17 · sync-spine (N2 — `src/server/{sync,derive}/**` on the SQL port) ·**
Four requests, in the order they block the MVP write path. Full reasoning in
`.claude/fleet/reports/sync-spine-netlify-db.md`.

1. **`src/server/defects/harness.ts` — widen to `SqlClient` and port its one
   write.** BLOCKING for defect detection on the Netlify database. `A7`'s
   `writeFindings()` still emits `PARSE_JSON(?)` + `TABLE(FLATTEN(...))` +
   `MERGE INTO`, and `DefectHarnessDeps.snowflake` is typed `SnowflakeClient`, so
   step 7 of the derivation pipeline **cannot run on Postgres**. The pipeline now
   checks `capabilities.variantJson && capabilities.mergeInto` before calling it
   and, when they are false, records `defect_rules` in `DERIVATION_RUN.STEPS_SKIPPED`
   and **also skips step 8** — a review state written from a screening that never
   happened is the exact failure the geo-assurance work exists to prevent. So on
   Postgres today: no defects are raised and no sample reaches a clean state; rows
   stay `captured` and read as `awaiting_derivation` in
   `CURATED.V_SAMPLE_GEO_ASSURANCE`. Loud, not silent — but it is a hole.

   The port is mechanical and everything it needs already exists:

   ```ts
   // 1. the type
   import type { SqlClient } from '../../shared/db/port.js';
   export interface DefectHarnessDeps { snowflake: SqlClient; /* … */ }
   // loadContext()'s four SELECTs are plain ANSI and need no change at all.

   // 2. the one write, dialect-aware — same shape as raiseDefectFromQuery()
   //    in src/server/derive/pipeline.ts, which is already ported and can be
   //    copied almost verbatim:
   import { syntaxFor } from '../sync/dialect.js';
   const syntax = syntaxFor(sf);
   //  - PARSE_JSON(?)                  -> syntax.parseJson('?')
   //  - TABLE(FLATTEN(input => X)) v   -> syntax.jsonArrayRows(X, 'v')   (v.value both sides)
   //  - v.value:defect_id::VARCHAR     -> syntax.jsonScalar('v.value', 'defect_id', 'text')
   //  - CURRENT_TIMESTAMP()            -> syntax.now
   //  - MERGE … ON t.DEFECT_ID         -> INSERT … ON CONFLICT (DEFECT_ID) DO UPDATE SET …
   //                                        WHERE t.RESOLUTION_STATE = 'open'
   ```

   `CURATED.SAMPLE_DEFECT.DEFECT_ID` is the primary key in both DDL files, and
   `MD5()` renders identical lowercase hex on both backends, so the deterministic
   defect id — and therefore "exactly one defect row" — survives the rewrite
   unchanged. When it lands, delete `harnessRunsOn()` in
   `src/server/derive/pipeline.ts`; the `runRules` seam next to it is how the
   tests already exercise step 8 on Postgres.

   **Owner:** `src/server/defects/harness.ts` is unowned in FLEET.md §1
   (`defect-rules` owns `rules/**` only). It is the third unowned path this
   Netlify work has hit, after `src/server/env.ts` and `src/shared/auth/**`.

2. **`CURATED.SAMPLE_DEFECT` has no `SYNC_BATCH_ID` column — in *either* DDL
   file.** `curatedMergeSql('local_defect', …)` stamped one on every row, which
   is an invalid-identifier error on both backends; device-raised defects have
   therefore never been writable. Stopped rather than adding a column: the
   mapping now carries `batchStamped: false` for `local_defect` and the write
   omits it. **If batch provenance on device-raised defects is wanted, add
   `SYNC_BATCH_ID varchar(64)` to `CURATED.SAMPLE_DEFECT` in both
   `snowflake_sampling_v01.sql` (or a v03 addendum) and
   `postgres_sampling_v01.sql`, and delete the flag** — one line each. The
   server-rule writers never set it either, so "no batch stamp on a defect" is a
   defensible design; it just was not what the parser did.
   `tests/acceptance/06-dual-backend-parity.test.ts` now checks every column the
   parser writes against both DDL files, which is what found this.

3. **`CURATED.DERIVATION_RUN` has no Snowflake counterpart.** The pipeline
   records one row per run per batch — backend, geo capability, steps completed,
   **steps skipped**, and the defect codes whose input was never computed. On
   Snowflake the table does not exist, so `DERIVATION_RUN_BACKENDS` in
   `src/server/derive/pipeline.ts` currently gates the insert to Postgres.
   Snowflake's run history is silently absent as a result. A `CREATE TABLE`
   matching `postgres_sampling_v01.sql` §6 (plus `SAMPLE_POINT.GEO_DERIVATION_STATE`
   / `GEO_DERIVED_TS`, which would make `V_SAMPLE_GEO_ASSURANCE` portable) makes
   the gate a one-line deletion. Not blocking — Snowflake runs every geographic
   step, so it has nothing to disclose — but the run history is worth having on
   the backend that ends up holding the season.

4. **`tests/support/fake-snowflake.ts` now has two port-typed wrappers around
   it** — `tests/acceptance/support/fake-sql-client.ts` (mine, a subclass) and
   `asPostgresClient()` in `tests/unit/ingest-postgres-port.test.ts`
   (`ingest-lane`'s). Both exist because the shared fake is used by tests neither
   lane owns. Worth collapsing into one helper in `tests/support/` once the wave
   closes; no behaviour depends on which is used.
