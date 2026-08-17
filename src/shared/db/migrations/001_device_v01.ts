/**
 * Device schema v01. Transcribed from `device_sqlite_v01.sql`.
 *
 * The .sql file is the reviewable artefact; this is what actually runs on a
 * phone. `schema.drift.test.ts` fails if the two disagree on the set of
 * tables, so the transcription cannot rot quietly.
 */

export const DEVICE_SCHEMA_V01 = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS bundle_manifest (
    bundle_id            TEXT PRIMARY KEY,
    etag                 TEXT,
    schema_version       TEXT NOT NULL,
    fetched_ts           TEXT NOT NULL,
    expires_ts           TEXT NOT NULL,
    boundary_count       INTEGER,
    plan_point_count     INTEGER,
    tile_pack_version    TEXT,
    server_time_at_fetch TEXT
);

CREATE TABLE IF NOT EXISTS ref_condition_code (
    condition_code   TEXT NOT NULL,
    code_set_version TEXT NOT NULL,
    condition_group  TEXT,
    display_label    TEXT,
    value_type       TEXT,
    value_options    TEXT,
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
    barcode_symbology TEXT,
    barcode_pattern   TEXT
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
    required_media_roles    TEXT,
    gps_accuracy_required_m REAL,
    min_gps_fix_count       INTEGER,
    max_plan_offset_m_warn  REAL,
    max_plan_offset_m_block REAL,
    default_lab_id          TEXT
);

CREATE TABLE IF NOT EXISTS assigned_boundary (
    boundary_id      TEXT PRIMARY KEY,
    property_id      TEXT,
    property_name    TEXT,
    operation_name   TEXT,
    geojson          TEXT NOT NULL,
    bbox_json        TEXT,
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

CREATE TABLE IF NOT EXISTS access_contact (
    contact_id   TEXT PRIMARY KEY,
    boundary_id  TEXT NOT NULL,
    person_id    TEXT,
    display_name TEXT,
    role_label   TEXT,
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
    prior_sample_uid TEXT,
    prior_lat        REAL,
    prior_lon        REAL,
    sequence_no      INTEGER,
    access_note      TEXT,
    local_status     TEXT DEFAULT 'pending',
    FOREIGN KEY (boundary_id) REFERENCES assigned_boundary(boundary_id)
);
CREATE INDEX IF NOT EXISTS ix_plan_point_boundary ON sample_plan_point(boundary_id);

CREATE TABLE IF NOT EXISTS field_visit (
    visit_id                 TEXT PRIMARY KEY,
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
    sync_state               TEXT DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS sample_point (
    sample_uid               TEXT PRIMARY KEY,
    visit_id                 TEXT NOT NULL,
    plan_point_id            TEXT,
    lat                      REAL,
    lon                      REAL,
    gps_accuracy_m           REAL,
    altitude_m               REAL,
    altitude_accuracy_m      REAL,
    position_provider        TEXT,
    position_source          TEXT,
    fix_count                INTEGER,
    fix_spread_m             REAL,
    fix_samples_json         TEXT,
    local_offset_from_plan_m REAL,
    deviation_reason_code    TEXT,
    captured_ts_device       TEXT,
    captured_ts_utc_offset   INTEGER,
    device_uptime_ms         INTEGER,
    sampler_person_id        TEXT,
    device_id                TEXT,
    period_code              TEXT,
    spec_id                  TEXT,
    protocol_version         TEXT,
    depth_achieved_cm        REAL,
    refusal_code             TEXT,
    cores_taken              INTEGER,
    bd_core_taken            INTEGER,
    note                     TEXT,
    supersedes_sample_uid    TEXT,
    sync_state               TEXT DEFAULT 'pending',
    FOREIGN KEY (visit_id) REFERENCES field_visit(visit_id)
);
CREATE INDEX IF NOT EXISTS ix_sample_visit ON sample_point(visit_id);
CREATE INDEX IF NOT EXISTS ix_sample_sync  ON sample_point(sync_state);

CREATE TABLE IF NOT EXISTS sample_bag (
    bag_id                 TEXT PRIMARY KEY,
    sample_uid             TEXT NOT NULL,
    bag_seq                INTEGER DEFAULT 1,
    bag_role               TEXT DEFAULT 'composite',
    depth_top_cm           REAL,
    depth_bottom_cm        REAL,
    lab_id                 TEXT,
    barcode_raw            TEXT,
    barcode_symbology      TEXT,
    barcode_capture_method TEXT,
    barcode_scanned_ts     TEXT,
    void_flag              INTEGER DEFAULT 0,
    void_reason_code       TEXT,
    sync_state             TEXT DEFAULT 'pending',
    FOREIGN KEY (sample_uid) REFERENCES sample_point(sample_uid)
);
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

CREATE TABLE IF NOT EXISTS media (
    media_id          TEXT PRIMARY KEY,
    content_hash      TEXT NOT NULL,
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
    local_path        TEXT,
    upload_state      TEXT DEFAULT 'pending',
    upload_attempts   INTEGER DEFAULT 0,
    uploaded_ts       TEXT,
    evicted_flag      INTEGER DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS outbox (
    outbox_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type     TEXT NOT NULL,
    entity_id       TEXT NOT NULL,
    operation       TEXT DEFAULT 'upsert',
    payload_json    TEXT NOT NULL,
    depends_on      TEXT,
    priority        INTEGER DEFAULT 100,
    state           TEXT DEFAULT 'pending',
    attempt_count   INTEGER DEFAULT 0,
    last_attempt_ts TEXT,
    last_error      TEXT,
    sync_batch_id   TEXT,
    created_ts      TEXT NOT NULL,
    acked_ts        TEXT,
    UNIQUE (entity_type, entity_id, operation)
);
CREATE INDEX IF NOT EXISTS ix_outbox_state ON outbox(state, priority, outbox_id);

CREATE TABLE IF NOT EXISTS device_session (
    session_id          TEXT PRIMARY KEY,
    device_id           TEXT,
    sampler_person_id   TEXT,
    crew_org_id         TEXT,
    refresh_token_enc   TEXT,
    offline_valid_until TEXT NOT NULL,
    last_unlock_ts      TEXT,
    unlock_failures     INTEGER DEFAULT 0,
    revoked_flag        INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS app_event (
    event_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    event_ts    TEXT NOT NULL,
    event_type  TEXT NOT NULL,
    detail_json TEXT,
    synced      INTEGER DEFAULT 0
);
`;
