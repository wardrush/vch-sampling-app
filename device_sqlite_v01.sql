-- ============================================================================
-- VCH Sampling App -- device-local schema (SQLite / sql.js / OP-SQLite) -- v01
-- 2026-08-16
--
-- Two halves, and the split matters:
--   * ref_* and assigned_* : READ-ONLY, replaced wholesale from the server
--     bundle. Never written by the app. Replacing rather than patching means
--     a corrupt local ref table is fixed by re-downloading, not by debugging.
--   * everything else      : WRITE-LOCAL, append-mostly, synced up via outbox.
--
-- Photo BYTES live in OPFS (or the native filesystem), keyed by content_hash.
-- Only metadata lives here. A 1 GB SQLite blob table is a bad week.
--
-- No row is ever deleted by the app. Eviction after successful sync is a
-- separate, deliberate, user-visible operation.
-- ============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Bundle manifest -- what this device currently believes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bundle_manifest (
    bundle_id           TEXT PRIMARY KEY,
    etag                TEXT,
    schema_version      TEXT NOT NULL,
    fetched_ts          TEXT NOT NULL,
    expires_ts          TEXT NOT NULL,   -- app warns, then blocks new visits
    boundary_count      INTEGER,
    plan_point_count    INTEGER,
    tile_pack_version   TEXT,
    server_time_at_fetch TEXT            -- clock-drift baseline
);

-- ---------------------------------------------------------------------------
-- READ-ONLY reference data (replaced wholesale)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ref_condition_code (
    condition_code   TEXT NOT NULL,
    code_set_version TEXT NOT NULL,
    condition_group  TEXT,
    display_label    TEXT,
    value_type       TEXT,               -- none | band | number | text
    value_options    TEXT,               -- JSON array
    sort_order       INTEGER,
    PRIMARY KEY (condition_code, code_set_version)
);

CREATE TABLE IF NOT EXISTS ref_deviation_reason (
    deviation_reason_code TEXT PRIMARY KEY,
    display_label         TEXT,
    requires_note         INTEGER DEFAULT 0,
    requires_photo        INTEGER DEFAULT 0,
    is_skip_reason        INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ref_defect_code (
    defect_code      TEXT PRIMARY KEY,
    display_label    TEXT,
    default_severity TEXT,
    raised_by        TEXT
);

CREATE TABLE IF NOT EXISTS ref_lab (
    lab_id            TEXT PRIMARY KEY,
    lab_name          TEXT,
    barcode_symbology TEXT,              -- nullable; scanner reports actual
    barcode_pattern   TEXT               -- advisory format check only
);

CREATE TABLE IF NOT EXISTS project_sampling_spec (
    spec_id                 TEXT PRIMARY KEY,
    project_id              TEXT,
    protocol_version        TEXT,
    period_code             TEXT,
    depth_top_cm            REAL,
    depth_bottom_cm         REAL,
    depth_increments_json   TEXT,
    overdrill_cm            REAL,
    cores_per_composite_min INTEGER,
    cores_per_composite_max INTEGER,
    composite_radius_m      REAL,
    bd_core_required        INTEGER,
    bag_scheme              TEXT,
    required_media_roles    TEXT,        -- JSON array
    gps_accuracy_required_m REAL,
    min_gps_fix_count       INTEGER,
    max_plan_offset_m_warn  REAL,
    max_plan_offset_m_block REAL,
    default_lab_id          TEXT
);

-- ---------------------------------------------------------------------------
-- READ-ONLY assignment (the week's work, scoped to this crew and nothing more)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assigned_boundary (
    boundary_id      TEXT PRIMARY KEY,
    property_id      TEXT,
    property_name    TEXT,
    operation_name   TEXT,
    geojson          TEXT NOT NULL,      -- polygon, WGS84
    bbox_json        TEXT,               -- fast pre-filter for map + PIP
    centroid_lat     REAL,
    centroid_lon     REAL,
    geom_acres       REAL,
    trs_canonical    TEXT,
    access_note      TEXT,
    plan_id          TEXT,
    spec_id          TEXT,
    period_code      TEXT,
    sort_order       INTEGER
);

-- Access contact ONLY. No other farmer PII reaches a contracted crew's
-- personal phone. This constraint is the whole BYOD data-exposure story.
CREATE TABLE IF NOT EXISTS access_contact (
    contact_id   TEXT PRIMARY KEY,
    boundary_id  TEXT NOT NULL,
    person_id    TEXT,
    display_name TEXT,
    role_label   TEXT,                   -- owner|operator|property_manager|row_contact
    phone        TEXT,
    is_primary   INTEGER DEFAULT 0,
    FOREIGN KEY (boundary_id) REFERENCES assigned_boundary(boundary_id)
);

CREATE TABLE IF NOT EXISTS sample_plan_point (
    plan_point_id    TEXT PRIMARY KEY,
    plan_id          TEXT,
    boundary_id      TEXT NOT NULL,
    plan_point_label TEXT,
    planned_lat      REAL NOT NULL,
    planned_lon      REAL NOT NULL,
    strata_label     TEXT,
    elevation_class  TEXT,
    prior_sample_uid TEXT,               -- true-up link, navigated in v2
    prior_lat        REAL,               -- v2
    prior_lon        REAL,               -- v2
    sequence_no      INTEGER,
    access_note      TEXT,
    -- local derived state, recomputed from sample_point; never synced up
    local_status     TEXT DEFAULT 'pending',  -- pending|sampled|skipped
    FOREIGN KEY (boundary_id) REFERENCES assigned_boundary(boundary_id)
);
CREATE INDEX IF NOT EXISTS ix_plan_point_boundary ON sample_plan_point(boundary_id);

-- ---------------------------------------------------------------------------
-- WRITE-LOCAL capture
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS field_visit (
    visit_id                 TEXT PRIMARY KEY,     -- UUIDv7 generated on device
    boundary_id              TEXT NOT NULL,
    plan_id                  TEXT,
    spec_id                  TEXT,
    crew_org_id              TEXT,
    sampler_person_id        TEXT,
    device_id                TEXT,
    access_contact_person_id TEXT,
    visit_date               TEXT,
    started_ts               TEXT,
    ended_ts                 TEXT,
    status                   TEXT DEFAULT 'in_progress',
    abandon_reason_code      TEXT,
    visit_note               TEXT,
    app_version              TEXT,
    sync_state               TEXT DEFAULT 'pending' -- pending|in_flight|acked
);

CREATE TABLE IF NOT EXISTS sample_point (
    sample_uid              TEXT PRIMARY KEY,      -- UUIDv7 at capture
    visit_id                TEXT NOT NULL,
    plan_point_id           TEXT,                  -- NULL = field-added
    lat                     REAL,
    lon                     REAL,
    gps_accuracy_m          REAL,
    altitude_m              REAL,
    altitude_accuracy_m     REAL,
    position_provider       TEXT,
    position_source         TEXT,                  -- gps|manual_map_pin|plan_inherited
    fix_count               INTEGER,
    fix_spread_m            REAL,
    fix_samples_json        TEXT,                  -- the raw fixes, for forensics
    local_offset_from_plan_m REAL,                 -- ADVISORY. Server recomputes
    deviation_reason_code   TEXT,
    captured_ts_device      TEXT,
    captured_ts_utc_offset  INTEGER,
    device_uptime_ms        INTEGER,               -- monotonic; exposes clock changes
    sampler_person_id       TEXT,
    device_id               TEXT,
    period_code             TEXT,
    spec_id                 TEXT,
    protocol_version        TEXT,
    depth_achieved_cm       REAL,                  -- exception only
    refusal_code            TEXT,
    cores_taken             INTEGER,               -- NULL = per spec
    bd_core_taken           INTEGER,
    note                    TEXT,
    supersedes_sample_uid   TEXT,
    sync_state              TEXT DEFAULT 'pending',
    FOREIGN KEY (visit_id) REFERENCES field_visit(visit_id)
);
CREATE INDEX IF NOT EXISTS ix_sample_visit  ON sample_point(visit_id);
CREATE INDEX IF NOT EXISTS ix_sample_sync   ON sample_point(sync_state);

CREATE TABLE IF NOT EXISTS sample_bag (
    bag_id                 TEXT PRIMARY KEY,       -- UUIDv7
    sample_uid             TEXT NOT NULL,
    bag_seq                INTEGER DEFAULT 1,
    bag_role               TEXT DEFAULT 'composite',
    depth_top_cm           REAL,
    depth_bottom_cm        REAL,
    lab_id                 TEXT,
    barcode_raw            TEXT,                   -- VERBATIM from the scanner
    barcode_symbology      TEXT,
    barcode_capture_method TEXT,                   -- scan|manual_entry|photo_recovered
    barcode_scanned_ts     TEXT,
    void_flag              INTEGER DEFAULT 0,
    void_reason_code       TEXT,
    sync_state             TEXT DEFAULT 'pending',
    FOREIGN KEY (sample_uid) REFERENCES sample_point(sample_uid)
);
-- Local duplicate detection. Warns; never blocks. A duplicate barcode on a
-- bag that is already in a box is a real fact, and the analyst queue owns it.
CREATE INDEX IF NOT EXISTS ix_bag_barcode ON sample_bag(lab_id, barcode_raw);

CREATE TABLE IF NOT EXISTS sample_condition (
    condition_id     TEXT PRIMARY KEY,
    sample_uid       TEXT NOT NULL,
    condition_code   TEXT NOT NULL,
    condition_value  TEXT,
    code_set_version TEXT,
    sync_state       TEXT DEFAULT 'pending',
    FOREIGN KEY (sample_uid) REFERENCES sample_point(sample_uid)
);

-- Metadata only. Bytes live in OPFS at media/<content_hash>.jpg
CREATE TABLE IF NOT EXISTS media (
    media_id          TEXT PRIMARY KEY,            -- UUIDv7
    content_hash      TEXT NOT NULL,               -- SHA-256 of the stored bytes
    sample_uid        TEXT,
    bag_id            TEXT,
    visit_id          TEXT,
    media_role        TEXT NOT NULL,
    is_required_role  INTEGER DEFAULT 0,
    capture_order     INTEGER,
    capture_ts_device TEXT,
    exif_lat          REAL,
    exif_lon          REAL,
    exif_ts           TEXT,
    exif_raw          TEXT,
    bytes             INTEGER,
    width_px          INTEGER,
    height_px         INTEGER,
    mime_type         TEXT,
    local_path        TEXT,                        -- OPFS key
    upload_state      TEXT DEFAULT 'pending',      -- pending|uploading|uploaded|failed
    upload_attempts   INTEGER DEFAULT 0,
    uploaded_ts       TEXT,
    evicted_flag      INTEGER DEFAULT 0,           -- bytes reclaimed after upload
    CHECK (sample_uid IS NOT NULL OR bag_id IS NOT NULL OR visit_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ix_media_upload ON media(upload_state);
CREATE INDEX IF NOT EXISTS ix_media_hash   ON media(content_hash);

CREATE TABLE IF NOT EXISTS local_defect (
    defect_id     TEXT PRIMARY KEY,
    sample_uid    TEXT,
    bag_id        TEXT,
    visit_id      TEXT,
    plan_point_id TEXT,
    defect_code   TEXT NOT NULL,
    severity      TEXT,
    detected_ts   TEXT,
    detail        TEXT,
    sync_state    TEXT DEFAULT 'pending'
);

-- ---------------------------------------------------------------------------
-- The outbox. This is the spine of the whole offline design.
-- A record shows as committed to the sampler ONLY when state = 'acked'.
-- Nothing is deleted on ack -- it is marked. Eviction is separate and later.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outbox (
    outbox_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type     TEXT NOT NULL,   -- field_visit|sample_point|sample_bag|
                                     -- sample_condition|media_meta|local_defect
    entity_id       TEXT NOT NULL,
    operation       TEXT DEFAULT 'upsert',
    payload_json    TEXT NOT NULL,
    depends_on      TEXT,            -- entity_id that must be acked first
    priority        INTEGER DEFAULT 100,  -- lower goes first; JSON before media
    state           TEXT DEFAULT 'pending', -- pending|in_flight|acked|failed
    attempt_count   INTEGER DEFAULT 0,
    last_attempt_ts TEXT,
    last_error      TEXT,
    sync_batch_id   TEXT,
    created_ts      TEXT NOT NULL,
    acked_ts        TEXT,
    UNIQUE (entity_type, entity_id, operation)
);
CREATE INDEX IF NOT EXISTS ix_outbox_state ON outbox(state, priority, outbox_id);

-- ---------------------------------------------------------------------------
-- Session / auth. Offline credentials for a BYOD device.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_session (
    session_id          TEXT PRIMARY KEY,
    device_id           TEXT,
    sampler_person_id   TEXT,
    crew_org_id         TEXT,
    refresh_token_enc   TEXT,        -- encrypted at rest, key in platform keystore
    offline_valid_until TEXT NOT NULL,   -- hard stop; app locks after this
    last_unlock_ts      TEXT,
    unlock_failures     INTEGER DEFAULT 0,
    revoked_flag        INTEGER DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- Local telemetry. Small, bounded, useful for the first season's post-mortem.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_event (
    event_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    event_ts    TEXT NOT NULL,
    event_type  TEXT NOT NULL,   -- capture_start|capture_commit|gps_timeout|
                                 -- scan_fail|sync_attempt|storage_warning
    detail_json TEXT,
    synced      INTEGER DEFAULT 0
);
