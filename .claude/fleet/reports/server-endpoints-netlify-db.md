# server-endpoints — Netlify database / N1 pass

**Tasks:** N1 (`.claude/fleet/TASK_BOARD.md` wave B) — fix `isMockMode()` so it no
longer keys directly on `SNOWFLAKE_ACCOUNT`, delete the deliberately-failing hazard
test that documented the defect. Scope is exactly this one-line behavioural fix plus
the one test deletion — no endpoint was ported to Postgres in this pass, per explicit
instruction.

**Gate:** `npm run typecheck && npm test` → **pass**. `tsc --noEmit` clean.
`vitest run` → **21 files, 216 passed, 1 skipped (217 total)**. Baseline going in was
21 files / 217 passed / 1 skipped (schema-steward's pass); the count is down by
exactly **one**, which is the deleted hazard test and nothing else — not a
regression. No other test in `tests/unit/postgres-adapter.test.ts` was touched, and no
file outside my owned paths plus the one instructed test deletion was written.

I ran alone against a tree `sync-spine` and `ingest-lane` may still be writing to
concurrently (FLEET.md §4 rule 5); their paths (`src/server/{sync,derive}/**`,
`src/ingest/**`) were untouched by me and I saw no failures attributable to them at
the time I ran the gate.

---

## Landed

| Task | Files | What it does |
|---|---|---|
| N1 | `src/server/dev/mock-mode.ts` | `isMockMode()` now returns `sqlBackend() === 'mock'` (imported from `../env.js`), replacing the old `MOCK_SNOWFLAKE === '1' \|\| !process.env.SNOWFLAKE_ACCOUNT`. Matches the steward's requested snippet exactly, plus a doc comment explaining why the old form was wrong and what it preserves. |
| N1 | `tests/unit/postgres-adapter.test.ts` | Deleted the one test case in `describe('the mock-mode composition hazard', …)` — the whole `describe` block, since it contained exactly one `it`. Removed the now-unused `vi` import from vitest (it was only used inside that block); left every other import and every other test in the file untouched. |

## Verified `sqlBackend()`'s real API before writing the fix

Read `src/server/env.ts` (schema-steward's, read-only). `sqlBackend(): SqlBackend`
exists exactly as the steward's request assumed, returning `'snowflake' | 'postgres'
| 'mock'`, resolved in this order: explicit `SQL_BACKEND` wins; else
`MOCK_SNOWFLAKE=1` → `mock`; else both `NETLIFY_DATABASE_URL` and
`SNOWFLAKE_ACCOUNT` present → throws (ambiguous deploy); else whichever of the two is
present; else `mock`. The requested one-line replacement was verified API, not a
guess — no deviation was needed.

## The four cases, verified directly (not just read)

Ran `src/server/dev/mock-mode.ts` and `src/server/env.ts` under `tsx` with `env -i`
(a genuinely empty environment plus only the variables under test, so no ambient
`SNOWFLAKE_*`/`NETLIFY_*` from this shell could contaminate a result):

```
bare checkout, no env vars              → sqlBackend=mock      isMockMode=true
MOCK_SNOWFLAKE=1 alone                  → sqlBackend=mock      isMockMode=true
MOCK_SNOWFLAKE=1 + SNOWFLAKE_ACCOUNT set → sqlBackend=mock      isMockMode=true
postgres via NETLIFY_DATABASE_URL       → sqlBackend=postgres  isMockMode=false
SQL_BACKEND=postgres explicit           → sqlBackend=postgres  isMockMode=false
SNOWFLAKE_ACCOUNT set                   → sqlBackend=snowflake isMockMode=false
```

1. **`MOCK_SNOWFLAKE=1` → still mock.** Confirmed, including with `SNOWFLAKE_ACCOUNT`
   also set — the escape hatch wins over real credentials, same as before.
2. **Bare checkout, no env vars at all → still mock.** Confirmed. This is the
   property F0.8 bought (`netlify dev` and the test suite run with nothing
   configured) and it survives unchanged.
3. **Postgres backend selected → not mock.** Confirmed both via `NETLIFY_DATABASE_URL`
   alone and via explicit `SQL_BACKEND=postgres`.
4. **Snowflake credentials present → not mock.** Confirmed, unchanged from before.

## Which endpoints consult `isMockMode()`, and behaviour in cases 1 and 2

```
netlify/functions/assignments-bundle.ts   (mine)
netlify/functions/ingest-validate.ts      (ingest-lane's)
```

Nothing else under `netlify/functions/` imports it — `nightly-*` and `analyst-*`
have no function file yet (out of scope for this pass and for the Netlify-database
port per the board), so there is nothing else to check.

Both call sites read `isMockMode() ? <fixtures> : <live path>`, with no other
condition gating the branch. In cases 1 and 2, `isMockMode()` returns `true`
identically before and after this change (verified above), so both endpoints take
the exact same fixture branch they always did — `mockBundle()` in
`assignments-bundle.ts`, `mockDeps()` in `ingest-validate.ts`. Neither endpoint's
behaviour changes in cases 1 or 2.

## Stopped, and why — reported, not fixed (in scope discipline)

**`assignments-bundle.ts`'s live branch will now be reachable under the Postgres
backend, and it will throw.** This is the direct, expected consequence of N1 doing
its job — case 3 above is supposed to stop being mock — but it surfaces a real gap
in my own owned path that I did not fix, per the task's explicit scope discipline
("if you notice one of your endpoints would break under the Postgres backend, report
it; do not fix it"):

- `assembleLiveBundle` (`src/server/assignments/bundle.ts`) and every helper it
  calls (`boundaryIdsForCrew`, `loadBoundaries`, `loadPlanPoints`,
  `loadAccessContacts`) are typed `snowflake: SnowflakeClient`, not `SqlClient`.
- The wrapper calls `snowflake()` from `src/server/env.ts` directly
  (`netlify/functions/assignments-bundle.ts:23`), which requires
  `SNOWFLAKE_ACCOUNT` and throws `missing required environment variable
  SNOWFLAKE_ACCOUNT` when it is absent — which it is, under
  `SQL_BACKEND=postgres`/MVP configuration.
- So `GET /v1/assignments/bundle` will 500 under the Postgres backend today. This
  matches the board's framing: A9 (nightly) and C14 (analyst queue) are explicitly
  out of scope for this pass, and the board/agent-file both say the assignments
  bundle, nightly pair and analyst queue "keep serving fixtures" for now — but that
  assumption was implicitly leaning on the old (wrong) `isMockMode()` always being
  true whenever Snowflake creds were absent. With N1 landed, that is no longer
  automatic; it now depends on which backend is selected, and Postgres is not mock.
- **Same shape of issue in `netlify/functions/ingest-validate.ts`'s `liveDepsFor`**
  (`ingest-lane`'s file, not mine to edit) — it also calls `snowflake()` directly and
  will throw under the Postgres backend for the same reason. Flagging it here because
  it is the same root cause as the assignments-bundle finding and both agents' reports
  will otherwise describe it independently.
- I did not port `assignments-bundle.ts` (or its `bundle.ts` deps) to `SqlClient`,
  and did not gate its live branch on `sqlBackend() === 'snowflake'` to fail more
  legibly. Both are real fixes but out of scope for N1 as scoped — "do not port your
  own endpoints to Postgres in this pass."

**Not otherwise reinterpreting the three open schema names** (`boundaryIdsForCrew`
ignoring `crew_org_id`, `loadAccessContacts`'s swallowed-to-`[]` failure, the
`OPERATION`/`PERSON` guesses in ingest) — untouched, as instructed; already recorded
in `integration/requests-a.md`.

## Needs from another agent

Recommend a board entry (orchestrator-owned; I did not edit `TASK_BOARD.md` or
`integration/requests-a.md` — shared files, and nothing here needed a new cross-lane
request beyond what schema-steward already logged): **N1 landing means
`assignments-bundle.ts`'s live path is now reachable under
`SQL_BACKEND=postgres`/MVP config and will throw for missing `SNOWFLAKE_ACCOUNT`.**
Whoever picks up A2's live-path port (or a scoping decision to gate it on
`sqlBackend() === 'snowflake'` and keep serving fixtures otherwise, matching the
board's stated intent that A9/C14/A2 stay fixture-only for now) needs this. Same for
`ingest-validate.ts`'s `liveDepsFor` (`ingest-lane`'s path).

## Files touched

`git status --short`, verbatim:

```
 M src/server/dev/mock-mode.ts
 M tests/unit/postgres-adapter.test.ts
```

No file was written outside `src/server/dev/**` and the one instructed test
deletion. No git command that writes was run.
