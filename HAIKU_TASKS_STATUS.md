# Haiku Tasks Status — ABC Plan (CONCURRENT_BUILD_PLAN_v01.md)

**Current branch:** `claude/haiku-tasks-abc-plan-a94oxv`  
**Date:** 2026-08-16  
**Status:** Foundation scaffolding required before lane work can begin

---

## Summary

The concurrent build plan structures work across three lanes with tagged escalations by model. Haiku tasks are distributed across:

1. **Foundation (F0)** — 4 Haiku-tagged items
2. **Lane A** — 1 Haiku-tagged task (A8)
3. **Lane B** — 5 Haiku-tagged tasks (B2, B9, B10, B12, B14)
4. **Lane C** — 11 Haiku-tagged tasks (C1–C6, C9, C10, C13, C15, C16)

**Total: 21 Haiku-scoped tasks across the build.**

---

## Completed (Haiku-tagged F0 work)

| # | Task | Status | Notes |
|---|---|---|---|
| F0.10 | CLAUDE.md ownership table + CODEOWNERS | ✅ Complete | Created CODEOWNERS with three-lane boundaries |
| F0.11 | Flatten doc-path discrepancy | ✅ Complete | Fixed `docs/` and `ddl/` references in claude.md to match actual root-level file locations |

**Commit:** `657d12f` — F0.10-F0.11 foundation work

---

## Blocked — Requires Foundation Scaffolding (F0.1-F0.4, F0.6, F0.8-F0.9)

### Immediate Blockers
No project scaffold exists yet:
- ❌ `package.json` (F0.1 — Sonnet)
- ❌ `vite.config.ts` (F0.1 — Sonnet)
- ❌ `tsconfig.json` (F0.1 — Sonnet)
- ❌ `netlify.toml` (F0.2 — Sonnet)
- ❌ Dependency lockfile (F0.3 — Sonnet)
- ❌ `src/shared/contract/*.ts` TS types (F0.4 — Opus)
- ❌ `src/shared/db/schema.ts` (F0.6 — Opus)
- ❌ Mock function handlers (F0.8 — Sonnet)
- ❌ Module stubs for all three lanes (F0.9 — Sonnet)

### Dependent Haiku Work That Awaits Foundation

**F0.5 — `src/shared/codes/*.ts`** (Haiku)  
*Depends on:* F0 skeleton exists, TypeScript configured  
*Task:* Transcribe defect codes, condition codes, deviation reasons, validation codes, entity priorities from `SYNC_CONTRACT_v01.md` §5 and `SCHEMA_AND_SYNC_ADDENDUM_v02.md` §4.2

**F0.7 — Fixtures** (Haiku)  
*Depends on:* F0 skeleton, `fixtures/` directory structure  
*Task:* Create:
  - `fixtures/bundle.f26-demo.json` — one boundary, six plan points, one unreadable barcode
  - `fixtures/plan_import_12row.tsv` — the exact fault set from ingest spec §8
  - `fixtures/sync_batch/*.json` — batch examples
  - `fixtures/defect_feed.json` — defect examples

**All Lane A, B, C Haiku tasks** (14 tasks)  
*Depends on:* Foundation F0.1-F0.9 complete, `npm run typecheck && npm test` passes

---

## Next Steps (Sequencing)

### Required Before Any Haiku Lane Work
1. **Run F0.1–F0.4 (Sonnet/Opus):** Repo scaffold, netlify.toml, dependencies, contract types
2. **Run F0.6–F0.9 (Opus/Sonnet):** SQLite schema, mock server, module stubs
3. **Gate check:** `npm run typecheck` and `netlify dev` both pass

### Then Haiku Can Proceed (In Dependency Order)
1. **F0.5** — Code sets transcription (pure spec translation, no dependencies)
2. **F0.7** — Fixtures from plan docs and ingest spec
3. **Lane A8** — Individual defect rules (harness A7 must exist first)
4. **Lane B: B2, B9, B10, B12, B14** — Form components and screen fragments
5. **Lane C: C1–C6** — Parse and validation clients (no server calls yet)
6. **Lane C: C9–C16** — Preview, map, commit, tutorial, redraw ERD

---

## Haiku Task List (Ready to Execute Once Foundation Exists)

### Foundation Tasks
- [ ] **F0.5** — `src/shared/codes/*.ts` — transcribe enum values from contract and addendum
- [ ] **F0.7** — `fixtures/` directory — create bundle, import, sync_batch, defect_feed examples

### Lane A
- [ ] **A8** — Individual defect rules (duplicate barcode, missing media, offset exceeded, clock drift, EXIF-GPS mismatch, gallery source, depth shortfall)

### Lane B
- [ ] **B2** — Design primitives (48 dp targets, glove/wind/low-sun palette, form components, chips, badges)
- [ ] **B9** — Capture screen: condition chips, deviation reason picker, depth/cores toggle
- [ ] **B10** — Skip screen: reason code, optional photo, optional note
- [ ] **B12** — Storage screen: used, free, reclaim uploaded photos
- [ ] **B14** — Tutorial branch (demo boundary, six fake points, deliberate bad barcode)

### Lane C
- [ ] **C1** — Clipboard paste parser (tab-separated, header optional)
- [ ] **C2** — File parser (CSV, TSV, XLSX, sheet picker)
- [ ] **C3** — Coordinate parsing (decimal, DMS, both formats, preserve raw)
- [ ] **C4** — Column mapping (synonyms, header guess, chips UI, positional fallback)
- [ ] **C5** — `IMPORT_PROFILE` persistence (per-user mapping, server-side)
- [ ] **C6** — Client-side validation (required fields, coord range, swapped lat/lon detection, duplicates, unmapped advisory)
- [ ] **C9** — Preview table (one row per input, status chips, header with counts)
- [ ] **C10** — Map preview panel (points over boundaries, color by status, hover link)
- [ ] **C13** — Tutorial branch (four-step walkthrough on 12-row fault file)
- [ ] **C15** — Redraw ERD with v02 tables
- [ ] **C16** — Acceptance tests (≥95% lab match, 300-row clipboard-to-commit under 30s, swapped coords fixed in one click)

---

## Why This Order Matters

Per §7 of the concurrent plan:
- **Lane A is critical path** — cannot be parallelised further (A3→A4→A6→A7 ordered)
- **Lane C at Haiku is the experiment** — proves whether detailed spec + Haiku is real savings
- **Integration risk is real** — three concurrent diffs need careful merge discipline

All three lanes develop against mocked functions (F0.8) and fixtures (F0.7) until integration week, so they never block on real Snowflake or function implementations.

---

## Key Principles (From Brief & Plan)

- **A whole batch is never rejected for one bad record** — degrade, don't fail
- **Raw payload persisted verbatim and content-hashed** before parsing (enables CURATED rebuild)
- **Capture never blocks on connectivity** — all validation client-side or cached
- **An upload never creates CRM records** — suggest, never create
- **Unrecognised columns preserved** into `extra_json`, visible as "unmapped"
- **Every input row written**, including blocked ones (auditability)
- **Missing data flags, does not drop** — nothing shown as committed until acked
- **Barcode never normalised in place** — manual entry tagged separately
- **`position_source` distinguishes satellite fix from dropped pin** — permanently

---

## Blocking Non-Engineering Items (From claude.md)

These five pre-work calls must complete for full build readiness:
1. Real barcode labels from Agidata (symbology, format, reuse)
2. BCarbon confirmation on exception-based depth/core evidence (one column if no)
3. Fall sampling window and crew size
4. **Thane's actual spreadsheet** — column-mapping fixture for C4–C5
5. **Snowflake service user + key-pair auth + network policy** (3 days to approve, 5 min to do)

Item 5 blocks A1, which cascades to A2, A4, A6, C7, C11. **Critical path blocker.**

---

## Files Touched
- `claude.md` — Fixed path references (F0.11)
- `CODEOWNERS` — Created with lane boundaries (F0.10)

**Commit hash:** `657d12f`  
**Ready to push:** Yes
