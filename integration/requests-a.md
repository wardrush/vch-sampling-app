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
