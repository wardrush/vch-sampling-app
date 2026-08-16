# claude.md — Sampling App: Data Schema & Build Plan

## Status: v02 COMPLETE (2026-08-16) — ready for consultant review and the fall-2026 pre-work calls

## Session goal

Answer whether enough context existed to design a sample-collection schema and an app plan. It did not — five things about the physical field workflow were undefined and each changed the schema. Interviewed Ward across four rounds, produced v01, then a second round of decisions (nightly sync, Netlify hosting, a plan-point ingest tool, phased auth, audit hardening, tutorial-vs-production branching) produced v02.

## Read these first

| File | Purpose |
|---|---|
| **`docs/SAMPLING_APP_PLAN_v02.md`** | **The plan. Start here.** Supersedes v01. D1–D18, six screens, stack, Netlify limits worked through, storage budget, auth phasing, audit trail, phasing, acceptance criteria, risks, and **Appendix A: which Claude model to build it with** |
| **`docs/PLAN_INGEST_SPEC_v01.md`** | Thane's upload surface — CSV/XLSX drop and Excel paste, columns, validation rules, mapping memory, map preview, commit semantics, tutorial vs production branch, token-URL auth |
| **`docs/SCHEMA_AND_SYNC_ADDENDUM_v02.md`** | Delta on the schema and sync contract. Read alongside v01, not instead of it |
| `docs/SAMPLING_SCHEMA_v01.md` | Base schema — still valid for everything not in the addendum |
| `docs/SYNC_CONTRACT_v01.md` | Base sync contract — still valid; §4 media tickets and §6 pipeline are amended by the addendum |
| `docs/sampling_erd.mermaid` | ERD (v01 tables; v02 additions are in the addendum, not yet drawn) |
| `ddl/snowflake_sampling_v01.sql` + `ddl/snowflake_v02_addendum.sql` | Deploy in that order. Addendum is CREATE + ALTER only |
| `ddl/device_sqlite_v01.sql` + `ddl/device_sqlite_v02_addendum.sql` | Same |
| `docs/SAMPLING_APP_PLAN_v01.md` | **Superseded.** Kept for the decision history only |

## Decisions (D1–D18, full table in plan v02 §1)

v01 established: one bag per point; pre-planned points with actual-vs-planned; lab pre-prints barcodes bound in the field; Android first with iOS parity; three required photo roles; custody deferred with the seam designed; contracted BYOD crew; structured conditions and coded deviation reasons; depth and cores as project constants with exception capture; office-side analyst queue; true-up link now and navigation in v2; fall 2026 target.

v02 added:

- **D8 restated — nightly sync expected, a week of offline tolerated.** Architecture unchanged; the operational expectation changed. Storage drops to ~150–400 MB steady state, iOS becomes viable in the pilot, and overnight defect turnaround becomes the real prize
- **D7 — hosting is Netlify.** Snowflake via SQL API v2 with key-pair JWT; Netlify Blobs for RAW payloads and MVP photo bytes; S3/R2 swap post-MVP behind the existing media-ticket interface
- **D15/D16 — plan points arrive via an ingest tool, and an upload never creates CRM records.** Operation and contact strings are suggested and analyst-resolved
- **D17 — auth phased.** Token URL exchanged for a session cookie in the MVP; shared IdP after
- **D18 — every surface gets a first-run tutorial branch on model data and a minimal-click production branch**, gated server-side so a new device does not re-teach an experienced user

## The design spine

Each sample is created once by one person and never edited by anyone else, so offline sync is a durable queue rather than a merge problem — no CRDTs, no vector clocks. The client generates all identity (UUIDv7) so nothing waits on a server. JSON syncs first and photo bytes second. Everything derived — boundary, TRS, offset-from-plan, defect flags — is computed server-side in one place so there is one answer. Raw payloads and raw uploaded files are stored verbatim and content-hashed, which is what makes the curated layer rebuildable.

## Netlify constraints that shaped the design

Synchronous functions 60 s; background 15 min; scheduled 30 s (so the nightly job kicks a background function rather than working); buffered payload 6 MB, ~4.5 MB effective for base64 binary; background payload 256 KB (so the derivation trigger passes a `sync_batch_id`, never data); Blobs 5 GB/object but **no direct browser upload — bytes must transit a function**. That last one is why photos go through a function in the MVP and swap to presigned S3/R2 later; the media-ticket contract already abstracts it, so the app does not change.

## Blocking pre-work — none of it is engineering

1. Real barcode labels from Agidata: symbology, format, cross-season reuse
2. BCarbon confirmation that **exception-based** depth/core evidence is acceptable (one column if not)
3. Fall sampling window and crew size
4. **Thane's actual current spreadsheet** — needed as the column-mapping fixture for the ingest tool
5. Snowflake service user with key-pair auth plus the network policy that permits it (three days to approve, five minutes to do)

## Unresolved

- Nullable `SAMPLE_POINT.boundary_id` vs a `BOUNDARY_UNKNOWN` sentinel
- Media retention policy, and now also `PLAN_IMPORT_ROW.raw_values_json` retention — it is the reproducibility anchor and also a copy of a spreadsheet that may carry contact details
- `crew_org_id` home: CRM `OPERATION` or its own table
- Operation match confidence threshold (configuration, not a constant — the candidate pool is about to grow an order of magnitude in Louisiana)
- Pilot against production `VCH_GEO` (recommended, with `IS_PILOT` on `FIELD_VISIT`) or an isolated schema
- Snowflake-vs-GCP write-path ownership — Netlify + the Snowflake SQL API scopes *around* R7 for this product; the platform question remains open

## Model recommendation (asked 2026-08-16)

Opus 5 (`claude-opus-5`, $5/$25 per MTok) for the offline sync worker, the derivation pipeline, and schema decisions. Sonnet 5 (`claude-sonnet-5`, $2/$10) for the bulk of the app. Haiku 4.5 (`claude-haiku-4-5-20251001`, $1/$5, 200k context) for scoped work with a written spec in front of it — parsers, individual validation rules, form components, fixtures, DDL boilerplate. Haiku alone is a false economy on a six-week schedule; Haiku in the mix is real savings, and this build is unusually suited to it *because these documents exist*. Full reasoning in plan v02 Appendix A.

## Next steps

1. Make the five pre-work calls. Items 1, 2 and 4 are one call each and two can invalidate design choices.
2. Send plan v02 + the ingest spec + the schema docs to the enrollment consultants alongside the July scoping v02.
3. Deploy `snowflake_sampling_v01.sql` then `snowflake_v02_addendum.sql`. The `CURATED.BOUNDARY` / `PROPERTY` / `LAB_RESULT` references assume Phase 1 entity-model names and may need adjusting to the live `FACT_BORDER` naming — one place in `V_IMPORT_PREVIEW`, flagged in a comment.
4. Correct D7 in the July scoping doc (W-2 + issued devices → contracted BYOD).
5. Redraw the ERD to include the v02 tables — not yet done.

## Notes for a future instance

- Source context read: `2026-07-28_vch-product-scoping/` (all), `VCH_PROJECT_CONTEXT.md`, memories `vch-soil-data-model` and `bcarbon-v3-soil-sampling`. Netlify limits and Claude model pricing were web-checked on 2026-08-16 and should be re-verified before budgeting.
- BCarbon v3.0 constraints all live in `REF.PROJECT_SAMPLING_SPEC` rather than in code or in someone's head: ≥30 cm with the *same* interval at baseline and true-up, 5–10 cores in a ≤2 m radius, bulk density at every location, one lab per project.
- Ward's voice: grounded, bounded judgment, steelman before critique, practical next steps, core caveats in the body not footnotes. Never conflate measured gain, credited tonnes, and distributed credits.
- Folder convention across the VCH parent is `YYYY-MM-DD_keyword`. `VCH_GEO` conventions are house style — do not invent a second one.
