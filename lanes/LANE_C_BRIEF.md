# Lane C — Ingest tool, then analyst queue

**Default model: Haiku 4.5 (`claude-haiku-4-5-20251001`). Branch: `lane/c-ingest`.**

## Paste this to start the instance

> Read `CONCURRENT_BUILD_PLAN_v01.md`, then `PLAN_INGEST_SPEC_v01.md` in full and `SCHEMA_AND_SYNC_ADDENDUM_v02.md` §2 and §4.3. You are **Lane C**. Work tasks C1–C16 from §3. You own only the paths marked `C` in §4 of the concurrent plan — `src/ingest/**`, `src/analyst/**`, `netlify/functions/ingest-*`, `fixtures/**`. Cross-lane needs go in `integration/requests-c.md`. Before every push run `npm run typecheck && npm test`, rebase onto the integration branch, and push to `lane/c-ingest`.

## The one hard rule

**An upload never creates CRM records.** Operation and contact columns land as *text* on `PLAN_IMPORT_ROW` with a match status and a suggestion; an analyst resolves them. Ninety-four clients already needed a hand-maintained table to separate sixty-eight growers from eighteen rollups and eight junk records. A tool that mints operations from a spreadsheet turns that one-off cleanup into an annual one. **Suggest, never create.** Everything else in this spec is a convenience decision; this one is structural and survives any argument about clicks.

## Also non-negotiable

- **Unrecognised columns are preserved, not dropped** — into `extra_json`, visible in the preview under "unmapped".
- **Every input row is written, including blocked ones.** An import that silently dropped five rows is an import nobody can audit.
- **An import is never edited after commit.** A correction is a new import producing a new `plan_version`. "Undo" retires the version it created and stops working once any point in it has been sampled.
- **Raw bytes stored verbatim and content-hashed** before anything is parsed into `CURATED`.
- **Swapped lat/lon is a one-click "swap all" fix**, not an error to hand-edit.
- **Skipping the tutorial still sets `tutorial_completed_ts`** — server-side, not a cookie. An adult who skips a tutorial has made a decision.
- **Target: a clean 300-row file, clipboard to committed, under thirty seconds, with zero mapping interaction on the second use.**

## Dependencies

- **C7 and C11 need Lane A's Snowflake client** (`src/shared/snowflake/`), due end of day 1.
- **C10 needs Lane B's `<BoundaryMap>`**, due end of day 3. Until then work against the F0.9 stub. If day 3 slips, reorder to C11–C13 and come back — the map is not on your critical path.
- **C5 and C13 need Lane A's session auth** (A10), due end of week 1.

## Escalations

**C11 (`/ingest/commit`)** is tagged **[OPUS]** — ordered multi-table write, idempotent on `content_hash` + `imported_by` + mapping so a double-click cannot double-import. **C7, C8, C12, C14** are **[SONNET]**; C8's fuzzy matching in particular is judgement, and its confidence threshold is configuration, not a constant. Switch with `/model`, then back.

## A note on this lane

Lane C is where v02 Appendix A's claim gets tested — that Haiku is real savings *because these documents exist*. If C1–C6 come back needing rework rather than review, the cut is wrong and this lane should move to Sonnet wholesale. That call gets made at the end of week 1, on evidence.
