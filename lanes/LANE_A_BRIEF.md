# Lane A — Sync spine & server

**Default model: Opus 5 (`claude-opus-5`). Branch: `lane/a-sync-spine`.**

## Paste this to start the instance

> Read `CONCURRENT_BUILD_PLAN_v01.md`, then `SAMPLING_APP_PLAN_v02.md`, `SYNC_CONTRACT_v01.md` and `SCHEMA_AND_SYNC_ADDENDUM_v02.md`. You are **Lane A**. Work tasks A1–A13 from §3 in order. You own only the paths marked `A` in §4 of the concurrent plan — do not write anywhere else; if you need a change in `src/shared/map/**` or a lane's own directory, append it to `integration/requests-a.md`. Before every push run `npm run typecheck && npm test`, rebase onto the integration branch, and push to `lane/a-sync-spine`. Start with A1 and A12, because Lanes B and C are waiting on A1 (day 1) and A10 (week 1).

## Order of work

Deliver these two first — other lanes are blocked behind them:

- **A1 · Snowflake SQL API client, end of day 1** — Lane C's `/ingest/validate` imports it
- **A10 · Token auth → session cookie, end of week 1** — Lane C's tutorial gate and Lane B's enrolment both need it

Then A12 (DDL deploy, blocked on the Snowflake service user), then the strict chain A3 → A4 → A5 → A6 → A7 → A8, with A2, A9, A11 slotted where they fit.

## Non-negotiables from the source documents

- **A whole batch is never rejected for one bad record** (contract §3). Degrade, don't fail.
- **Raw payload is persisted verbatim and content-hashed before parsing.** Contract §6 step 1 exists so `CURATED` can be rebuilt from `RAW` byte-identically — v02 §11 criterion 5. It is the first thing someone who has not needed it will cut.
- **Background function payload is a `sync_batch_id`, never data** — 256 KB cap.
- **The media ticket returns a URL and the client does not know what is behind it.** Keep that seam clean; the S3/R2 swap must stay server-side.
- **Derived values are computed server-side only** — TRS, boundary, offset-from-plan. The device's figure is advisory and is not stored.
- `V_IMPORT_PREVIEW` references `CURATED.BOUNDARY` / `PROPERTY` / `LAB_RESULT` on Phase 1 entity-model names and may need adjusting to live `FACT_BORDER` naming. One place, already flagged in a comment.

## Escalations

A8 (individual defect rules) is tagged **[HAIKU]** and A2/A9 **[SONNET]** — switch down with `/model` for those, then back. Everything else in this lane stays on Opus.
