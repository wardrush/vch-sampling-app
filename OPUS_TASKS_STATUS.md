# Opus tasks — status

*Companion to `CONCURRENT_BUILD_PLAN_v01.md`. Every task tagged **[OPUS]** in
that plan, and what state it is in.*

This is the handoff note for the Sonnet and Haiku lanes: the contract, the
device schema and the sync spine now exist, so Lane B and Lane C can be opened.

---

## Done

| # | Task | Where |
|---|---|---|
| **F0.4** | Wire contract — bundle, sync batch, media ticket, defect feed, ingest | `src/shared/contract/**` |
| **F0.6** | Device SQLite bootstrap + forward-only migration runner | `src/shared/db/**` |
| **A1** | Snowflake SQL API v2 client, key-pair JWT, stateless | `src/shared/snowflake/**` |
| **A3** | Outbox worker — priority, `depends_on`, blind retry, partial ack, resume | `src/sync/**` |
| **A4** | `/sync/batch` — verbatim RAW then MERGE on client keys | `src/server/sync/**`, `netlify/functions/sync-batch.ts` |
| **A5** | Media tickets, upload path, hash-verified commit | `src/server/media/tickets.ts`, `netlify/functions/sync-media-*.ts` |
| **A6** | Derivation pipeline as a background function | `src/server/derive/pipeline.ts`, `netlify/functions/derive-batch-background.ts` |
| **A7** | Defect rule harness — idempotent per batch, `visible_to_field` from REF | `src/server/defects/harness.ts` |
| **A10** | Token auth → signed httpOnly session cookie | `src/shared/auth/{token,session}.ts`, `netlify/functions/auth-session.ts` |
| **A11** | `AUDIT_EVENT` writer + the offline device session | `src/shared/auth/{audit,offline}.ts` |
| **A13** | Acceptance tests, v02 §11 criteria 1–5 | `tests/acceptance/**` |
| **B6** | GPS capture — averaging, spread, pin-vs-fix | `src/app/capture/gps.ts` |
| **B8** | Camera capture — downscale, EXIF, `capture_source` | `src/app/capture/camera/**` |
| **C11** | `/ingest/commit` — ordered multi-table write, double-click safe | `src/ingest/commit/**`, `netlify/functions/ingest-commit.ts` |

`npm run typecheck && npm test` — 80 tests, all passing, no network required.

## Partly done, and honestly so

**A12 · Deploy the DDL.** The deploy itself is **blocked on the Snowflake
service user, key pair and network policy** (pre-work item 5). What landed
instead is everything that does not need credentials:

- `tools/deploy-ddl.ts` — the runner, with `--dry-run`. Splits statements
  correctly around `$$ … $$` procedure bodies and quoted literals.
- `snowflake_v03_entity_compat.sql` — the `V_IMPORT_PREVIEW` fix, done the only
  honest way available. The live `FACT_BORDER` naming cannot be confirmed from
  the repository, and a wrong guess would deploy and then fail at query time
  looking like a code bug. So the three scattered entity-model references are
  collapsed into **two views** (`V_BOUNDARY_ENTITY`, `V_LAB_RESULT_ENTITY`).
  When the live names are known, that is a single edit in a known place.
- The same file seeds `REF.DEFECT_FIELD_VISIBILITY`, which shipped empty in
  v02 — meaning every defect is currently invisible to the field.

**Run `npx tsx tools/deploy-ddl.ts --dry-run` before the real one.**

## Deliberately left to the lane that owns it

- **A8 · the individual defect rules** ([HAIKU]). The harness, the rule
  interface and two reference rules are in place — `duplicate-barcode.ts` and
  `no-gps-fix.ts`, written because A13's criterion 3 needed something real to
  assert against. `PENDING_A8_RULES` in `src/server/defects/rules/index.ts`
  names the six still outstanding. A new rule should read like the two that are
  there: a pure function over `RuleContext`, no IO, no clock.
- **F0.5 · the full code sets** ([HAIKU]). `src/shared/codes/index.ts` holds
  only what the Opus modules import by name — defect codes, severities, field
  visibility, audit actions. Condition codes, deviation reasons and validation
  codes are still to transcribe.
- **F0.1/F0.2/F0.3/F0.8/F0.9** ([SONNET]). A minimal scaffold exists —
  `package.json`, `tsconfig.json`, `vitest.config.ts` and three dependencies —
  because the Opus tasks had to typecheck and run. **`netlify.toml`, the full
  dependency install, the mock function server and the module stubs are still
  F0's job**, and F0.2/F0.3 should be done before B and C are opened so the
  lockfile is written once.
- **F0.7 · fixtures** ([HAIKU]) and **F0.11 · the doc-path flattening**
  ([HAIKU]). Neither is started. F0.7 is what stops B and C blocking on A.

## Two things a reviewer should look at first

1. **`src/server/sync/merge.ts` takes the source expression as a parameter.**
   `/sync/batch` passes `PARSE_JSON(?)`; the rebuild path passes a select over
   `RAW.SYNC_PAYLOAD`. One parse, two callers — which is what makes "CURATED is
   rebuildable from RAW" (§11.5) a property of the code rather than a claim.
   `tests/acceptance/05-rebuild-from-raw.test.ts` asserts the two projections
   are byte-identical.

2. **Deterministic ids do the work transactions usually get asked to do.**
   Defects key on `MD5(subject|code)`; an import and everything under it keys on
   `content_hash + imported_by + mapping`. A re-run of the pipeline or a
   double-clicked commit therefore converges instead of duplicating, including
   in the case that motivates it — where the detect-then-insert approach races
   itself.

## One bug worth naming

The force-quit acceptance test caught a real defect in the first cut of the
outbox worker: a retryable *transport* failure returned rows to `pending`,
which handed them a fresh `sync_batch_id` on the next attempt. A batch the
server had already committed would then have arrived looking new. Rows now stay
`in_flight` with the error noted (`OutboxStore.noteAttemptError`), and resume
under their original batch id. That distinction — between the server answering
"retry this record" and the server not answering at all — is the whole basis of
blind-retry safety.

## Still blocking, and none of it is engineering

Unchanged from plan v02 §10 and concurrent plan §6:

1. **Snowflake service user + key pair + network policy.** Blocks A12, and A12
   blocks anything that needs a live warehouse.
2. **Thane's actual current spreadsheet** — Lane C's mapping layer is being
   built against a guess without it.
3. **Real barcode labels from Agidata.**
4. **BCarbon confirmation on exception-based depth/core evidence.**
5. **Fall window and crew size.**
