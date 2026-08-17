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
