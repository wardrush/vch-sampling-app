# Sync Contract — v01

*2026-08-16 · Viridi Data · companion to `SAMPLING_SCHEMA_v01.md`*

The write path host is undecided — new dedicated service, existing GCP portal API, or Snowflake direct. This document specifies the **contract** so that decision can be made late and changed once without touching the app. Host recommendation is in `SAMPLING_APP_PLAN_v01.md` §6.

---

## 1. The five properties that make offline sync boring

Offline sync gets a reputation for difficulty because most systems try to merge concurrent edits. This one does not have concurrent edits: each sample is created once, by one person, on one device, and is never edited by anyone else. That single fact removes CRDTs, vector clocks, and operational transforms from the design. What remains is a durable queue with retries.

1. **Client generates all identity.** UUIDv7 for `visit_id`, `sample_uid`, `bag_id`, `media_id`, `sync_batch_id`. Time-ordered, collision-safe without coordination, sortable. No server round-trip is ever required to create a record.
2. **Every write is an idempotent upsert on the client key.** Re-sending a batch is safe by construction, which means the client can retry blindly and the server needs no deduplication logic beyond `MERGE`.
3. **Nothing is committed in the UI until the server acknowledges it.** The outbox count is always visible. "Synced" is a fact, not an assumption.
4. **JSON goes first, media goes second.** A sample record is ~4 KB and must land the moment a signal appears. Photos are ~350 KB each and can take days. Separating them means a week of records reaches the warehouse over a gas-station connection while the photos continue in the background.
5. **Corrections are new rows.** `supersedes_sample_uid` and upsert-never-delete, matching `VCH_GEO`. The server rejects mutation of a record already in `review_state = 'accepted'`.

---

## 2. Down-sync: the assignment bundle

`GET /v1/assignments/bundle?crew_org_id=…&period=F26`
`If-None-Match: <etag>`

Returns everything the device needs for a multi-week deployment, in one signed response:

```json
{
  "bundle_id": "01J...",
  "etag": "sha256:...",
  "schema_version": "1.0",
  "server_time": "2026-09-28T14:02:11Z",
  "expires_ts": "2026-10-26T00:00:00Z",
  "specs":          [ { "spec_id": "...", "depth_top_cm": 0, ... } ],
  "ref_condition_code":   [ ... ],
  "ref_deviation_reason": [ ... ],
  "ref_defect_code":      [ ... ],
  "ref_lab":              [ ... ],
  "boundaries":     [ { "boundary_id": "...", "geojson": {...}, "geom_acres": 158.2, ... } ],
  "plan_points":    [ { "plan_point_id": "...", "planned_lat": 47.9, ... } ],
  "access_contacts":[ { "boundary_id": "...", "display_name": "...", "role_label": "operator", "phone": "..." } ],
  "tile_pack": { "version": "f26-nd-w-01", "url": "...", "bytes": 214000000, "sha256": "..." }
}
```

Rules:

- **Replace, never patch.** Reference and assignment tables are dropped and reloaded from a bundle. A corrupt local ref table is then fixed by re-downloading, not by debugging a merge.
- **`expires_ts` is enforced.** The app warns at seven days out and refuses to start a *new* visit past expiry. It never blocks completing or syncing work already begun — stranding a crew's day is worse than a stale contact list.
- **`server_time` establishes the clock-drift baseline.** The device records the delta at fetch and stores `device_uptime_ms` per sample, which is how a clock changed mid-deployment becomes detectable rather than silent.
- **Access contacts only.** No other person data crosses to the device. On a contracted crew's own phone, that is the entire data-exposure story.
- **Tile pack is fetched separately** and is the only large download. It is content-hashed and resumable.

---

## 3. Up-sync: records

`POST /v1/sync/batch`
`Idempotency-Key: <sync_batch_id>`

```json
{
  "sync_batch_id": "01J...",
  "device_id": "dev_...",
  "app_version": "1.0.4",
  "schema_version": "1.0",
  "client_sent_ts": "2026-10-02T23:11:04Z",
  "records": [
    { "entity_type": "field_visit",   "entity_id": "01J...", "payload": { ... } },
    { "entity_type": "sample_point",  "entity_id": "01J...", "payload": { ... } },
    { "entity_type": "sample_bag",    "entity_id": "01J...", "payload": { ... } },
    { "entity_type": "sample_condition", "entity_id": "01J...", "payload": { ... } },
    { "entity_type": "media_meta",    "entity_id": "01J...", "payload": { ... } },
    { "entity_type": "local_defect",  "entity_id": "01J...", "payload": { ... } }
  ]
}
```

Response — **per-record**, always, even on partial failure:

```json
{
  "sync_batch_id": "01J...",
  "server_received_ts": "2026-10-02T23:11:09Z",
  "accepted": ["01J...", "01J..."],
  "rejected": [
    { "entity_id": "01J...", "code": "SCHEMA_VERSION_UNSUPPORTED", "retryable": false,
      "detail": "field 'position_source' unknown in schema 0.9" }
  ],
  "media_upload_tickets": [
    { "media_id": "01J...", "content_hash": "sha256:...",
      "action": "upload", "url": "https://…signed…", "expires_ts": "..." },
    { "media_id": "01J...", "content_hash": "sha256:...", "action": "already_have" }
  ]
}
```

Contract details that matter:

- **A whole batch is never rejected for one bad record.** Degrade-not-fail, same as the `VCH_GEO` loader. Bad records land in `RAW.SYNC_PAYLOAD` regardless and become a defect, not a data loss.
- **Batch size cap ~200 records or 2 MB**, whichever comes first. Small enough to complete on a 30-second connectivity window.
- **`retryable` is explicit.** The client backs off on retryable failures and moves the record to `state='failed'` with a visible badge on non-retryable ones. A silently-stuck outbox is the failure mode that loses a season.
- **The raw payload is stored verbatim before parsing**, content-hashed, in `RAW.SYNC_PAYLOAD`. When the parse changes, the curated layer is rebuilt from there.
- **Backoff:** 5 s, 30 s, 2 min, 10 min, 1 h, then hourly. Jittered. Reset on any successful batch.

---

## 4. Up-sync: media

Two-phase, so the same photo is never uploaded twice and a half-uploaded photo never becomes a half-record.

1. Media **metadata** rides in the record batch (`entity_type: "media_meta"`). The server returns a ticket per media item.
2. `action: "already_have"` — the content hash is known; the client marks it uploaded without transferring a byte. Duplicate label photos across a crew cost nothing.
3. `action: "upload"` — the client `PUT`s the bytes to the signed URL. Resumable (tus or S3/GCS multipart) with a 5 MB part size, so a dropped connection at 80% resumes at 80%.
4. `POST /v1/sync/media/commit` with `{media_id, content_hash, bytes}`. The server verifies the hash against the stored object and sets `upload_state='uploaded'`. **Hash mismatch fails the commit and the client re-uploads** — the alternative is a silently corrupt photograph, discovered by an analyst in April.

Media upload only runs on unmetered connections by default, with a manual "upload now on cellular" override. On a BYOD phone, quietly consuming a sampler's personal data plan is how an app gets uninstalled.

---

## 5. Ordering and dependencies

The outbox `priority` column enforces:

| Priority | Entity | Why |
|---|---|---|
| 10 | `field_visit` | Parent of everything else |
| 20 | `sample_point` | The record that matters most |
| 30 | `sample_bag`, `sample_condition`, `local_defect` | Children of the sample |
| 40 | `media_meta` | Small; unlocks the upload tickets |
| 90 | media **bytes** | Large, slow, background, last |
| 95 | `app_event` telemetry | Never competes with data |

`depends_on` handles the case where a child is queued before its parent has been acked. The server also accepts children ahead of parents and holds them in a pending-parent state for 30 days — because a device that is wiped mid-deployment should not orphan the records that did arrive.

---

## 6. Server-side pipeline after a batch lands

Ordered, idempotent, re-runnable per `sync_batch_id`:

1. Persist verbatim → `RAW.SYNC_PAYLOAD` (content-hashed).
2. Parse + `MERGE` into `CURATED.*` on the client keys.
3. `TRY_TO_GEOGRAPHY` on lat/lon → `GEOG`, set `GEOG_VALID`. Invalid geometry degrades to a defect, never fails the batch.
4. Point-in-polygon → `BOUNDARY_ID`. No match → `POINT_OUTSIDE_BOUNDARY` (blocking defect).
5. Derive `TRS_CANONICAL` from the coordinate. Never accepted from the device.
6. Compute `OFFSET_FROM_PLAN_M` and `BEARING_FROM_PLAN_DEG` against the plan point. One implementation, one answer; the device's local figure is advisory only and is not stored.
7. Run the server-rule defect set (duplicate barcode, missing required media role, offset exceeded with no deviation reason, clock drift, EXIF-vs-GPS mismatch, unsampled plan points past a plan's close date).
8. Set `REVIEW_STATE`: `screened` if no open defect, `needs_review` if any.
9. Update `SYNC_BATCH` counts and `DEVICE.last_seen_ts`.

Steps 3–8 are pure functions of the raw payload plus reference data, which means the whole curated layer can be rebuilt from `RAW` at any time. That property is the reason step 1 exists and it is the first thing that gets cut by someone who has not yet needed it.

---

## 7. Auth on a BYOD device that is offline for a week

- Enrolment happens **online**, once, in the office or the motel: OIDC sign-in, device registered, `device_id` bound to person and crew org.
- The device holds an encrypted refresh token and an **offline session valid for a configured window** — start at 14 days, tune after the first season. `offline_valid_until` is a hard stop; past it the app locks and no new capture is possible until it sees a network.
- Unlock is biometric or a 6-digit PIN, per app open. Not per capture — a sampler with cold, muddy hands re-authenticating at every hole will find a workaround, and the workaround will be paper.
- Local database and media are encrypted at rest with a key held in the platform keystore (Android Keystore / iOS Keychain), not derived from the PIN alone.
- **Revocation is a sync-time refusal plus a self-wipe instruction.** A phone that never comes back online cannot be wiped; the mitigation is the 14-day offline window and the fact that the only person data on it is a contact name and phone number for assigned properties. State that plainly rather than implying remote wipe works on a device that is off.
- Data is scoped by `crew_org_id` at bundle generation. A contracted crew's device physically cannot contain another crew's assignments.
