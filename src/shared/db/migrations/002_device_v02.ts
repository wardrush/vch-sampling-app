/**
 * Device schema v02 addendum. Transcribed from `device_sqlite_v02_addendum.sql`.
 *
 * SQLite's `ALTER TABLE` has no `IF NOT EXISTS` for columns, so these
 * statements are not individually idempotent. The `user_version` gate in
 * `schema.ts` is what makes the *migration* idempotent — which is the reason
 * the runner exists rather than a pile of `CREATE TABLE IF NOT EXISTS`.
 */

export const DEVICE_SCHEMA_V02 = `
ALTER TABLE media ADD COLUMN capture_source   TEXT DEFAULT 'unknown';
ALTER TABLE media ADD COLUMN device_id        TEXT;
ALTER TABLE media ADD COLUMN exif_gps_present INTEGER;

CREATE TABLE IF NOT EXISTS field_defect (
    defect_id        TEXT PRIMARY KEY,
    defect_code      TEXT NOT NULL,
    severity         TEXT,
    detected_ts      TEXT,
    sample_uid       TEXT,
    plan_point_id    TEXT,
    plan_point_label TEXT,
    boundary_id      TEXT,
    lat              REAL,
    lon              REAL,
    field_guidance   TEXT,
    acked_ts         TEXT,
    ack_sync_state   TEXT DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS ix_field_defect_boundary ON field_defect(boundary_id);
CREATE INDEX IF NOT EXISTS ix_field_defect_acked    ON field_defect(acked_ts);

CREATE TABLE IF NOT EXISTS local_profile (
    person_ref            TEXT PRIMARY KEY,
    surface               TEXT,
    tutorial_completed_ts TEXT,
    tutorial_skipped_flag INTEGER DEFAULT 0,
    last_synced_ts        TEXT
);

CREATE TABLE IF NOT EXISTS device_info (
    device_id           TEXT PRIMARY KEY,
    platform            TEXT,
    device_model        TEXT,
    manufacturer        TEXT,
    os_version          TEXT,
    app_version         TEXT,
    user_agent_raw      TEXT,
    screen_px           TEXT,
    enrolled_ts         TEXT,
    storage_quota_bytes INTEGER,
    storage_persisted   INTEGER
);
`;
