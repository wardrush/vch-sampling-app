# Schema & Sync Addendum — v02

*2026-08-16 · delta against `SAMPLING_SCHEMA_v01.md` and `SYNC_CONTRACT_v01.md`*
*A delta, not a rewrite — v01 stays valid for everything not listed here. DDL: `ddl/snowflake_v02_addendum.sql`, `ddl/device_sqlite_v02_addendum.sql` (CREATE + ALTER, deployable on top of v01).*

---

## 1. What the nightly-sync assumption changes in the schema

**Nothing.** Recorded here so nobody goes looking. Client-generated identity, the outbox, idempotent upsert, JSON-before-media, two-phase resumable media — every one of those is required for a single unreliable nightly sync exactly as much as for a week-deferred one. The changes below all come from Netlify hosting, the ingest tool, and the audit gaps, not from the sync cadence.

Two constants move, and only as configuration: bundle `expires_ts` and `offline_valid_until` may shorten from 14 days to 10. Neither should go to 2 — see plan §5 on protecting the slack.

---

## 2. New tables

### 2.1 `RAW.PLAN_IMPORT_FILE`

The uploaded bytes, verbatim, content-hashed. Same discipline as raw lab files and raw sync payloads. For a paste, the pasted text is the artefact.

`content_hash` PK, `original_filename`, `mime_type`, `bytes`, `source_kind` (`file_upload | clipboard_paste`), `blob_key`, `uploaded_by`, `uploaded_ts`.

### 2.2 `CURATED.PLAN_IMPORT`

The import event.

`import_id` PK, `content_hash` FK, `imported_by`, `imported_ts`, `source_kind`, `original_filename`, `sheet_name`, `mapping_json` (the resolved column mapping, so an import is reproducible from its raw file), `period_code`, `project_id`, `row_count`, `rows_committed`, `rows_blocked`, `rows_flagged`, `plan_ids` (array of plans this import created or revised), `status` (`staged | committed | retired`), `retired_by`, `retired_ts`, `retire_reason`.

### 2.3 `CURATED.PLAN_IMPORT_ROW`

One row per input row — **including the blocked ones**. The rejected rows are part of the record; an import that silently dropped five rows is an import nobody can audit.

`import_row_id` PK, `import_id` FK, `source_row_no`, `raw_values_json` (verbatim, pre-mapping), `plan_point_label`, `lat_raw`, `lon_raw`, `lat`, `lon`, `coord_format_detected` (`decimal | dms | unknown`), `coord_fix_applied` (e.g. `swap_lat_lon`), `boundary_id_stated`, `boundary_id_resolved`, `strata_label`, `elevation_class`, `sequence_no`, `access_note`, `prior_sample_uid`, `extra_json` (unmapped columns, preserved), `operation_text`, `operation_match_id`, `operation_match_score`, `operation_match_status` (`matched | suggested | unmatched | resolved_by_analyst`), `contact_name_text`, `contact_phone_text`, `contact_email_text`, `contact_match_id`, `contact_match_status`, `row_status` (`ready | flagged | blocked | committed | superseded`), `validation_codes` (array), `plan_point_id` (populated on commit).

**Design note — the one that matters.** `operation_text` and the contact columns are *text*. This table is where a spreadsheet's version of a grower's name stops, and an analyst decides whether it is a new operation or the fifty-fifth spelling of an existing one. The reason is arithmetic rather than principle: ninety-four clients already required a hand-maintained table to separate sixty-eight growers from eighteen internal rollups and eight junk records. A tool that mints operations from a spreadsheet turns that one-off cleanup into an annual one, and at Louisiana scale into a standing one.

### 2.4 `CURATED.IMPORT_PROFILE`

Per-user memory. Makes the second upload zero-click and gates the tutorial.

`profile_id` PK, `person_ref` (token identity for MVP, `person_id` after IdP), `surface` (`ingest | sampler`), `mapping_json` (last accepted column mapping), `mapping_updated_ts`, `tutorial_completed_ts`, `tutorial_skipped_flag`, `default_period_code`, `default_project_id`, `import_count`.

**Server-side, not a cookie.** A new laptop or a new phone must not re-teach an experienced user. This requirement is one of the reasons the MVP needs soft identity at all.

### 2.5 `CURATED.INGEST_ACCESS_TOKEN` — MVP only, dropped at IdP

`token_id` PK, `token_hash` (never the token itself), `person_ref`, `display_name`, `surface`, `crew_org_id`, `issued_by`, `issued_ts`, `expires_ts`, `revoked_ts`, `revoked_reason`, `last_used_ts`, `use_count`.

A link is a bearer credential. Bounded to one trusted contractor and one season, rotatable and revocable, and exchanged immediately for a signed httpOnly session cookie so that replacing it with the shared IdP is a swap of the session-establishment step rather than a rewrite of every request path.

### 2.6 `CURATED.AUDIT_EVENT`

Actor log for the surfaces that are not the sampling app. The app's own attribution lives on its rows; the office-side surfaces need somewhere to write.

`event_id` PK, `event_ts`, `actor_ref`, `actor_kind` (`token | idp_user | service`), `surface`, `action` (`import_commit | import_retire | defect_resolve | plan_release | device_enroll | device_revoke | token_issue | token_revoke`), `entity_type`, `entity_id`, `detail_json`, `ip_hash`, `user_agent_raw`.

---

## 3. Altered tables

### 3.1 `CURATED.MEDIA` — three additions, one of them important

| Column | Why |
|---|---|
| **`CAPTURE_SOURCE`** — `in_app_camera \| device_gallery \| unknown` | The single most important audit distinction in the media table, and it was missing from v01. A photograph picked from the camera roll is not evidence of having been at the hole. **Required roles accept `in_app_camera` only**; gallery selection is permitted for `issue_photo` and `other` and is permanently marked |
| `DEVICE_ID` | So a photograph's provenance stands alone without traversing to its parent sample |
| `EXIF_GPS_PRESENT` | Cheap boolean; makes "how many photos carried their own fix" a query rather than a `VARIANT` unpack |

New defect code: **`MEDIA_GALLERY_SOURCED`** (severity `review`) when a gallery photo is attached to a required role — which the app should prevent, so the rule exists to catch the case where it did not.

### 3.2 `CURATED.DEVICE` — three additions

`DEVICE_MODEL`, `MANUFACTURER`, `USER_AGENT_RAW`. "An Android phone" is not a device record, and on a BYOD fleet the device inventory is the only fleet inventory there is.

### 3.3 `CURATED.SAMPLE_PLAN` / `SAMPLE_PLAN_POINT` — provenance from the import

`SAMPLE_PLAN.import_id` and `SAMPLE_PLAN_POINT.import_row_id`, both nullable — a plan may still be authored by an analyst rather than uploaded. With them, "where did this point come from" resolves to a row in a spreadsheet with a content hash and a person's name on it.

### 3.4 `CURATED.SAMPLE_DEFECT` — down-sync support

`VISIBLE_TO_FIELD` (boolean, default false) and `FIELD_ACKED_TS`. Only defects a crew can actually act on are pushed down (§4.2); the rest stay in the office. `FIELD_ACKED_TS` records that a sampler saw it, which is different from it being resolved.

---

## 4. Sync contract changes

### 4.1 Media tickets under Netlify

`SYNC_CONTRACT` §4 already returns a ticket containing *a URL*, and the client neither knows nor cares what is behind it. That seam now earns its keep:

- **MVP:** `action: "upload"` returns a Netlify Function URL. The client POSTs the photo as multipart. A ~400 KB JPEG encodes to ~533 KB, comfortably inside Netlify's ~4.5 MB effective binary payload limit. Bytes land in Netlify Blobs, content-verified against the hash.
- **Post-MVP:** the same field returns an S3/R2 presigned PUT. **No client change.**
- **`action: "already_have"` is unchanged** and matters more under Netlify, since every avoided upload is avoided function bandwidth.
- **Resumability is lost on the MVP path.** A drop at 80% restarts. Tolerable at 400 KB, and one more reason the swap happens before high volume. The client's retry logic is identical either way, so nothing needs writing twice.

### 4.2 Defect down-sync — new endpoint

`GET /v1/defects/open?crew_org_id=…&since=…`

Returns defects raised overnight against this crew's recent work where `visible_to_field = true`, each with the sample's coordinate, its plan point label, the defect's plain-language explanation, and a suggested action. Rendered as **"yesterday's flags"** on the Today screen with a revisit affordance on the affected points.

Which codes go down: `BARCODE_DUPLICATE`, `BARCODE_UNREAD`, `MISSING_REQUIRED_MEDIA`, `NO_GPS_FIX`, `GPS_ACCURACY_EXCEEDED`, `POINT_OUTSIDE_BOUNDARY`, `PLAN_POINT_UNSAMPLED`, `DEPTH_SHORTFALL`. Which stay in the office: `CLOCK_DRIFT_SUSPECTED`, `LATE_SYNC`, `EXIF_POSITION_MISMATCH`, `MEDIA_GALLERY_SOURCED` — a crew cannot act on any of them and pushing them down is noise that trains people to ignore the list.

`POST /v1/defects/{id}/ack` records `FIELD_ACKED_TS`. Acknowledging is not resolving; only an analyst resolves.

**This is v1.5, not v1.** It depends on the analyst queue existing and on nightly sync being real, and both are things the pilot establishes rather than assumes.

### 4.3 Ingest endpoints

`POST /ingest/validate` — parsed rows in (never the workbook; SheetJS parses client-side), per-row validation out: coordinate parse and range, point-in-polygon against active boundaries, duplicate checks within the file and against released plans, operation and contact fuzzy matches with scores and top-three candidates. Stateless, idempotent, no writes. A 5,000-row file is comfortably inside the 60-second synchronous budget.

`POST /ingest/commit` — writes `RAW.PLAN_IMPORT_FILE`, `PLAN_IMPORT`, `PLAN_IMPORT_ROW` (all rows including blocked), then `SAMPLE_PLAN` and `SAMPLE_PLAN_POINT` for the committed rows, raises analyst-queue items for unresolved operations and contacts, and writes `AUDIT_EVENT`. Idempotent on `content_hash` + `imported_by` + mapping, so a double-click cannot double-import.

`POST /ingest/retire/{import_id}` — retires the plan version an import created. Refuses once any point in it has been sampled. `AUDIT_EVENT` on both outcomes, including the refusal.

### 4.4 Server pipeline as a Netlify background function

`SYNC_CONTRACT` §6's nine steps move into a background function (15-minute ceiling, ample) triggered after a batch lands. Its payload is a `sync_batch_id`, never the data — the background payload cap is 256 KB. The nightly scheduled function has a 30-second ceiling, so it does no work itself: it enumerates what needs doing and kicks background functions.

Snowflake is reached via the **SQL API v2 with key-pair JWT auth** — stateless, no driver, no connection pool to keep warm across cold starts. This needs a Snowflake service user, a key pair, and a network policy permitting it. That is pre-work item 5 in the plan and it is the kind of thing that takes three days to get approved and five minutes to do.

---

## 5. Still open after v02

Unchanged from v01: nullable `boundary_id`, media retention, `crew_org_id`'s home, pilot-vs-production schema. Added:

- **Whether `PLAN_IMPORT_ROW` should retain `raw_values_json` indefinitely.** It is the reproducibility anchor for a plan, and it is also a copy of a spreadsheet that may contain contact details. Retention and redaction are the same conversation as media retention, and neither is written.
- **Operation match confidence threshold.** Written as configuration rather than a constant, because the right number is a function of how many candidates exist, and that number is about to grow by an order of magnitude in Louisiana.
