# Sample Collection Data Schema — v01

*2026-08-16 · Viridi Data · companion to `SAMPLING_APP_PLAN_v01.md` and `SYNC_CONTRACT_v01.md`*
*Extends the physical layer of `2026-07-28_vch-product-scoping/docs/ENTITY_MODEL_APPENDIX.md`. Inherits `VCH_GEO` conventions. Does not invent a second convention.*

---

## 1. What changed from the entity-model appendix

The appendix had two tables where the field reality needs six. Below is the delta, stated up front so nobody has to diff two ERDs.

| Appendix | This schema | Why |
|---|---|---|
| `SAMPLE_ASSIGNMENT` (one row, `planned_lat/lon` + `status`) | `SAMPLE_PLAN` → `SAMPLE_PLAN_POINT` → `FIELD_VISIT` | The plan is authored once by an analyst and is a stable artifact. The visit is what a crew does on a given day. Collapsing them means the plan mutates every time someone drives out, and "what was the original plan" becomes unanswerable. |
| `SAMPLE_POINT.lab_barcode` as a column | `SAMPLE_BAG` as its own table | Confirmed v1 rule is one bag per point. The bag is still its own row so the second bag — a bulk-density core, a split depth increment, an LSU parallel — is an insert rather than a migration. Cost today: one join. |
| `defect_flags` as a delimited string | `SAMPLE_DEFECT` rows against `REF_DEFECT_CODE` | A string of flags cannot be counted, queued, or resolved. The analyst queue is the whole point of capturing defects. |
| — | `PROJECT_SAMPLING_SPEC` | Depth interval, core count, composite radius, and required photo roles are project constants pushed to the device, not per-point typing. This table is what makes the app multi-project and multi-protocol without a rebuild. |
| — | `SAMPLE_CONDITION` | Structured site conditions, many per point, coded against versioned reference data. |
| `LAB_RESULT.sample_uid` | `LAB_RESULT.bag_id` | The lab receives a bag, not a hole. With one bag per point the two are equivalent today; they stop being equivalent the moment a bulk-density bag exists, and repointing the FK later means touching every lab result row ever loaded. |
| — | `SHIPMENT` / `SHIPMENT_BAG` | Stub only. Tables exist, `SAMPLE_BAG.shipment_id` is nullable, no v1 UI. The seam is designed; the feature is deferred. |

Retained verbatim from the appendix: `sample_uid` is a VCH surrogate generated in-app at capture, the barcode is an attribute, and the lab join is on `(lab_id, lab_barcode, received_date)` — never the barcode alone.

---

## 2. The grain, in one paragraph

One **plan point** is a coordinate an analyst wants sampled. One **field visit** is a crew on a boundary on a date. One **sample point** is a hole in the ground, carrying the actual coordinate, the deviation from plan, and the conditions found there. One **bag** is what goes to the lab and carries the pre-printed barcode. One **media** row is a photograph, attached to either a sample point, a bag, or a whole visit — deliberately not 1:1 with anything. A plan point may produce zero sample points (inaccessible), one (the normal case), or more than one (re-drilled after refusal). A sample point may exist with no plan point (field-added). Every one of those cases is a row, not an exception.

---

## 3. ERD

See `docs/sampling_erd.mermaid` for the rendered version.

```
PROPERTY ──< BOUNDARY ──< SAMPLE_PLAN ──< SAMPLE_PLAN_POINT
                │                              │
                └──< FIELD_VISIT ──< SAMPLE_POINT ──< SAMPLE_BAG ──> LAB_RESULT
                          │              ├──< SAMPLE_CONDITION
                          │              ├──< SAMPLE_DEFECT
                          └──< MEDIA >───┘
PROJECT ──< PROJECT_SAMPLING_SPEC
DEVICE ──< SYNC_BATCH ──< (everything captured)
SHIPMENT ──< SHIPMENT_BAG ──> SAMPLE_BAG        [stub, v2]
```

---

## 4. Table reference

Provenance columns (`LOAD_TS`, `LOADED_BY`, `LAST_UPDATED_TS`, `LAST_UPDATED_BY`, `ROW_HASH`) are on every table, defaulted to `CURRENT_TIMESTAMP()` / `CURRENT_USER()`, never typed by a human. They are omitted from the descriptions below for readability. Full DDL in `ddl/snowflake_sampling_v01.sql`.

### 4.1 `REF.PROJECT_SAMPLING_SPEC`

The configuration that makes the app protocol-aware. Pushed to the device with the assignment bundle; the sampler never types any of it.

| Column | Note |
|---|---|
| `spec_id` PK, `project_id`, `protocol_version` | Versioned; a project can have more than one spec over time, effective-dated |
| `period_code` | `S25`, `F25`, `S26` … |
| `depth_top_cm`, `depth_bottom_cm` | The interval. BCarbon v3.0 requires the *same* interval at baseline and true-up in a sub-area — this column is where that consistency becomes checkable instead of remembered |
| `depth_increments_json` | e.g. `[[0,15],[15,30]]`. One bag per point in v1 means this is documentation today and drives bag count when it stops being one |
| `overdrill_cm` | Sample ≥5 cm below target depth, per protocol |
| `cores_per_composite_min`, `_max` | 5–10 per v3.0 |
| `composite_radius_m` | ≤2 m per v3.0 |
| `bd_core_required` | Whether an undisturbed bulk-density core is taken alongside |
| `required_media_roles` | Array. v1: `["label_photo","core_photo","site_photo"]` |
| `gps_accuracy_required_m` | Capture gate, default 10 |
| `max_plan_offset_m_warn`, `_block` | Distance from the planned point that triggers a warning vs. requires a deviation reason |

**Design note.** Depth and core count were deliberately *not* made mandatory per-point fields. They live here as project constants, and the sample row records only the exception (`depth_achieved_cm`, `refusal_code`) when reality departs from the spec. That is two taps saved per hole across ~40K samples a year and still produces the evidence a verifier asks for — the claim becomes "the spec says 0–30 cm, and here are the 214 points where it was not achieved and why," which is stronger than 40,000 hand-typed numbers of unknown reliability. The counter-argument is real: a verifier who wants per-sample attestation rather than exception reporting will not accept it. Worth confirming with BCarbon before the fall run, and it is a one-column change if the answer comes back badly.

### 4.2 `CURATED.SAMPLE_PLAN` / `SAMPLE_PLAN_POINT`

The analyst's authored plan. Immutable once released; a revision is a new plan version with `parent_plan_id`.

`SAMPLE_PLAN`: `plan_id` PK, `boundary_id` FK, `spec_id` FK, `period_code`, `plan_version`, `parent_plan_id`, `status` (`draft | released | superseded`), `released_ts`, `released_by`, `point_count`.

`SAMPLE_PLAN_POINT`: `plan_point_id` PK, `plan_id` FK, `plan_point_label` (what the sampler sees — the successor to the Master Sheet's Soil Strat Point ID), `planned_lat`, `planned_lon`, `strata_label`, `stratification_method`, `elevation_class` (`A_high | B_low | null` — preserves the existing A/B pair convention), `prior_sample_uid` FK nullable (the true-up link; populated now, navigated to in v2), `sequence_no`, `access_note`.

### 4.3 `CURATED.FIELD_VISIT`

A crew on a boundary on a date. This is where the roster, the device, and the day live.

`visit_id` PK (client-generated), `boundary_id` FK, `plan_id` FK nullable, `crew_org_id`, `sampler_person_id` FK, `device_id` FK, `visit_date`, `started_ts`, `ended_ts`, `status` (`in_progress | complete | abandoned`), `abandon_reason_code`, `access_contact_person_id` FK (whoever is stored as the access contact for the property — owner, operator, or named manager; the app never assumes the owner), `visit_note`, `app_version`, `spec_id`.

### 4.4 `CURATED.SAMPLE_POINT`

The hole. One row per hole actually drilled.

| Column | Note |
|---|---|
| `sample_uid` PK | UUIDv7, generated on device at the moment of capture. Time-ordered, collision-safe offline, sortable. The primary key of the whole chain |
| `visit_id`, `plan_point_id` FK nullable | Nullable plan point = field-added sample |
| `boundary_id` FK | Resolved server-side by point-in-polygon, never sent by the device |
| `lat`, `lon`, `gps_accuracy_m` | Captured at the moment of sampling, not at form submit |
| `altitude_m`, `altitude_accuracy_m`, `position_provider`, `fix_count`, `fix_spread_m` | The app takes several fixes over a short window and stores the best plus the spread. A tight spread at 8 m accuracy is a different fact from a single 8 m fix |
| `position_source` | `gps | manual_map_pin | plan_inherited`. A pin dropped on a map is a legitimate fallback and must be distinguishable from a satellite fix forever |
| `offset_from_plan_m`, `bearing_from_plan_deg` | Computed server-side, not device-side. One implementation, one answer |
| `deviation_reason_code` FK | Required when `offset_from_plan_m` exceeds the spec's block threshold, or when a plan point is skipped |
| `captured_ts_device`, `captured_ts_utc_offset`, `device_uptime_ms` | Device clock plus monotonic uptime. Clock drift and manual clock changes are detectable rather than silent |
| `synced_ts`, `server_received_ts` | Server clock, written server-side |
| `sampler_person_id`, `device_id`, `sync_batch_id` | Attribution |
| `depth_achieved_cm`, `refusal_code`, `cores_taken` — all nullable | Exception capture only. `NULL` means "per the spec", which is the normal case and costs the sampler nothing |
| `bd_core_taken` | Boolean, defaults from spec |
| `period_code`, `spec_id`, `protocol_version` | Denormalized onto the row deliberately — the spec in force at capture time must survive the spec being superseded |
| `trs_canonical` | Derived server-side from the coordinate. Never typed. The TRS correction lineage in the current export is a standing record of what manual entry costs |
| `review_state` | `captured → screened → needs_review → accepted | rejected` |
| `supersedes_sample_uid` nullable | Corrections are new rows. Upsert-never-delete, same as `VCH_GEO` |
| `note` | Free text, last resort |

### 4.5 `CURATED.SAMPLE_BAG`

What goes to the lab.

`bag_id` PK (UUIDv7, device-generated), `sample_uid` FK, `bag_seq` (1 in v1), `bag_role` (`composite | bulk_density | duplicate_qc | blank`), `depth_top_cm`, `depth_bottom_cm` (default from spec), `lab_id` FK, `barcode_raw`, `barcode_symbology`, `barcode_capture_method` (`scan | manual_entry | photo_recovered`), `barcode_scanned_ts`, `barcode_duplicate_flag`, `shipment_id` FK nullable, `void_flag`, `void_reason_code`.

**Design notes.**
- `barcode_raw` is stored exactly as the scanner returned it, including leading zeros, check digits, and any prefix. Normalization happens in a derived column, never in place. The current lab-name corruption problem (`N`→`M`, dashes→spaces) is what normalizing-on-write produces.
- `barcode_symbology` comes from the scanner, not a config file. Agidata's symbology is unconfirmed; the design accepts any 1D or 2D symbology and treats the payload as opaque.
- Duplicate barcodes cannot be prevented offline. The device checks locally and warns; the server flags `barcode_duplicate_flag` at sync and routes both rows to the analyst queue. Rejecting at sync would strand a sample that exists in a box.
- `void_flag` handles the torn label, the dropped bag, the mis-scan caught in the truck.

### 4.6 `CURATED.SAMPLE_CONDITION`

`condition_id` PK, `sample_uid` FK, `condition_code` FK → `REF.CONDITION_CODE`, `condition_value` nullable (for coded values that carry a magnitude — residue cover percent band, water depth band), `code_set_version`.

Many rows per point. Adding a condition code next season is a reference-data insert, not a schema change and not a new column on a 40,000-row-a-year table.

### 4.7 `CURATED.MEDIA`

Deliberately not 1:1 with samples.

| Column | Note |
|---|---|
| `media_id` PK | UUIDv7, device-generated |
| `content_hash` | SHA-256 of the bytes. Addresses the object store. Same photo uploaded twice costs one object |
| `sample_uid` FK nullable, `bag_id` FK nullable, `visit_id` FK nullable | At least one must be non-null. A photo of a blocked field approach belongs to the visit, not to any hole |
| `media_role` | `label_photo | core_photo | site_photo | issue_photo | other` |
| `capture_ts_device`, `exif_lat`, `exif_lon`, `exif_ts` | EXIF preserved verbatim. The camera's own fix is independent corroboration of the app's fix, and the two disagreeing is a finding |
| `bytes`, `width_px`, `height_px`, `mime_type` | |
| `object_key`, `upload_state` (`pending | uploading | uploaded | failed`), `uploaded_ts` | Media syncs separately from and after the record |
| `capture_order`, `is_required_role` | |

`(sample_uid, media_role)` is **not** unique. Three site photos of one hole is a legitimate thing a sampler does.

### 4.8 `CURATED.SAMPLE_DEFECT`

`defect_id` PK, `sample_uid` FK nullable, `bag_id` FK nullable, `visit_id` FK nullable, `defect_code` FK, `detected_by` (`device | server_rule | analyst`), `detected_ts`, `severity` (`blocking | review | advisory`), `resolution_state` (`open | resolved | accepted_as_is | escalated`), `resolved_by`, `resolved_ts`, `resolution_note`.

Starting `REF.DEFECT_CODE` set:

| Code | Severity | Raised by |
|---|---|---|
| `NO_GPS_FIX` | review | device |
| `GPS_ACCURACY_EXCEEDED` | review | device |
| `MANUAL_POSITION` | advisory | device |
| `BARCODE_UNREAD` | blocking | device |
| `BARCODE_DUPLICATE` | blocking | server_rule |
| `BARCODE_FORMAT_UNEXPECTED` | review | server_rule |
| `MISSING_REQUIRED_MEDIA` | review | server_rule |
| `MEDIA_UPLOAD_STALLED` | advisory | server_rule |
| `POINT_OUTSIDE_BOUNDARY` | blocking | server_rule |
| `PLAN_OFFSET_EXCEEDED` | review | server_rule |
| `NO_DEVIATION_REASON` | review | server_rule |
| `DEPTH_SHORTFALL` | review | device |
| `CLOCK_DRIFT_SUSPECTED` | review | server_rule |
| `EXIF_POSITION_MISMATCH` | advisory | server_rule |
| `PLAN_POINT_UNSAMPLED` | review | server_rule |
| `LATE_SYNC` | advisory | server_rule |

`POINT_OUTSIDE_BOUNDARY` is blocking and deserves a note: at 1MM acres, a point twenty metres outside a boundary is usually a boundary problem, not a sampling problem, and the analyst queue is where that distinction gets made. The rule flags; it never drops.

### 4.9 `CURATED.DEVICE`, `SYNC_BATCH`

`DEVICE`: `device_id` PK, `crew_org_id`, `device_label`, `platform` (`android_pwa | ios_pwa | android_native | ios_native | zebra`), `os_version`, `app_version`, `is_managed` (false for BYOD), `enrolled_ts`, `last_seen_ts`, `revoked_ts`.

`SYNC_BATCH`: `sync_batch_id` PK (client-generated, the idempotency key), `device_id`, `client_sent_ts`, `server_received_ts`, `record_count`, `accepted_count`, `rejected_count`, `raw_payload_hash` → `RAW.SYNC_PAYLOAD`, `app_version`, `schema_version`.

Every captured row carries `sync_batch_id`. Replaying a batch is then a bounded operation rather than a search.

### 4.10 `RAW.SYNC_PAYLOAD`

The verbatim device JSON, content-hashed, never edited. Same discipline as raw lab files. When a parse changes, the curated layer is rebuilt from here rather than from memory. This is the cheapest insurance in the design and the first thing that gets cut by someone who has not needed it yet.

### 4.11 `SHIPMENT` / `SHIPMENT_BAG` — stub

`SHIPMENT`: `shipment_id` PK, `crew_org_id`, `lab_id`, `carrier`, `tracking_number`, `shipped_ts`, `received_ts`, `bag_count_declared`, `bag_count_received`, `status`.
`SHIPMENT_BAG`: `shipment_id` FK, `bag_id` FK, `scanned_ts`, `scanned_by`.

No v1 UI. The tables and the nullable `SAMPLE_BAG.shipment_id` exist so the closed loop — every bag accounted for between field and lab, and "the lab never received it" becoming provable rather than arguable — drops in without a migration on a table that by then has hundreds of thousands of rows.

---

## 5. The lab join, restated

The barcode is an attribute, not a key.

```sql
LAB_RESULT  ⟕  SAMPLE_BAG
  ON  lr.lab_id = b.lab_id
 AND  normalize(lr.lab_barcode) = normalize(b.barcode_raw)
 AND  lr.received_date BETWEEN b.barcode_scanned_ts::date
                           AND b.barcode_scanned_ts::date + INTERVAL '120 days'
```

`match_status` on `LAB_RESULT` stays as specified in the appendix: `full | corrected | partial | unmatched`. The date window is what makes barcode reuse across seasons survivable, and Agidata should be asked directly whether they reuse — the answer changes the window, not the design.

The `photo_recovered` capture method exists for exactly this failure: a scan that produced garbage, a label photograph that a human reads, and a corrected barcode with `match_status = 'corrected'` and an actor on the correction.

---

## 6. Device-local schema

The device mirrors a narrow subset. Full DDL in `ddl/device_sqlite_v01.sql`.

**Read-only, refreshed from server (the assignment bundle):**
`ref_condition_code`, `ref_deviation_reason`, `ref_defect_code`, `ref_lab`, `project_sampling_spec`, `assigned_boundary` (GeoJSON + acres + access notes), `sample_plan_point`, `access_contact` (name, role label, phone — nothing more), `bundle_manifest` (version, etag, fetched_ts, expires_ts).

**Write-local, sync-up:**
`field_visit`, `sample_point`, `sample_bag`, `sample_condition`, `media` (metadata; bytes in OPFS keyed by content hash), `local_defect`, `outbox`.

**`outbox`** is the spine of the sync design: `outbox_id`, `entity_type`, `entity_id`, `payload_json`, `attempt_count`, `last_attempt_ts`, `last_error`, `state` (`pending | in_flight | acked | failed`), `created_ts`. A record is displayed to the sampler as committed only when `state = 'acked'`. Nothing is deleted locally on ack — it is marked, and eviction is a separate, later, deliberate step.

**No PII beyond what the day requires.** The bundle carries the access contact for assigned properties and nothing else. On a contracted crew's personal phone, that constraint is the entire data-exposure story.

---

## 7. Open items this schema does not settle

1. **Agidata barcode symbology and reuse policy.** Design is symbology-agnostic, so this blocks the *scanner configuration*, not the schema. Needs one phone call and a photograph of a real label.
2. **Whether BCarbon accepts exception-based depth evidence** rather than per-sample attestation (§4.1). One-column change if not.
3. **Whether `SAMPLE_POINT.boundary_id` should be nullable.** Shown as resolved-server-side and non-null. Points outside all known boundaries do occur — 473 of 882 Master points landed inside the seven uploaded projects. Nullable with a blocking defect is probably right; shown here as non-null against a `BOUNDARY_UNKNOWN` sentinel. Argue it.
4. **Retention of media.** Photographs are the bulkiest artifact in the whole platform and the least queried. No retention policy is written here, and one should exist before the first season fills the bucket.
5. **Crew organisation model.** `crew_org_id` appears on device, visit, and shipment without a defined table, because the CRM layer's `OPERATION` may or may not be the right home for a contracted sampling partner. Needs deciding alongside the Phase 1 entity model, not separately.
