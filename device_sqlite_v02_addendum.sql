-- ============================================================================
-- VCH Sampling App -- device-local schema, v02 ADDENDUM
-- 2026-08-16
--
-- Deploy ON TOP OF ddl/device_sqlite_v01.sql.
-- SQLite ALTER TABLE supports ADD COLUMN only -- all changes below are additive
-- by design, which is also the right constraint for an app that ships to
-- devices that may be a version behind.
--
-- The nightly-sync assumption changed nothing structural here either. Two
-- constants move as CONFIG, not schema: bundle expiry and offline session
-- window may shorten from 14 days to 10.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- MEDIA -- the audit gap closed in v02.
-- A photograph picked from the camera roll is not evidence of having been at
-- the hole. The app enforces in_app_camera for required roles; this column is
-- what makes that enforcement auditable rather than merely claimed.
-- ---------------------------------------------------------------------------
ALTER TABLE media ADD COLUMN capture_source    TEXT DEFAULT 'unknown';
                                     -- in_app_camera | device_gallery | unknown
ALTER TABLE media ADD COLUMN device_id         TEXT;
ALTER TABLE media ADD COLUMN exif_gps_present  INTEGER;

-- ---------------------------------------------------------------------------
-- Defect down-sync. Read-only, replaced wholesale from the server, same as
-- the other ref_/assigned_ tables. Only codes a crew can ACT on arrive here.
-- v1.5 -- table ships in v1 so the app does not need a migration mid-season.
-- ---------------------------------------------------------------------------
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
    field_guidance   TEXT,           -- plain language, written for a phone
    acked_ts         TEXT,           -- seen != resolved. Only an analyst resolves
    ack_sync_state   TEXT DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS ix_field_defect_boundary ON field_defect(boundary_id);
CREATE INDEX IF NOT EXISTS ix_field_defect_acked    ON field_defect(acked_ts);

-- ---------------------------------------------------------------------------
-- Per-user memory, mirrored locally so the tutorial branch resolves before
-- the first network call. The SERVER copy is authoritative -- a new phone
-- must not re-teach an experienced user.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS local_profile (
    person_ref             TEXT PRIMARY KEY,
    surface                TEXT,
    tutorial_completed_ts  TEXT,
    tutorial_skipped_flag  INTEGER DEFAULT 0,
    last_synced_ts         TEXT
);

-- ---------------------------------------------------------------------------
-- Device fingerprint, captured once at enrolment and sent with every batch.
-- On a BYOD fleet this is the only fleet inventory there is.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device_info (
    device_id       TEXT PRIMARY KEY,
    platform        TEXT,     -- android_pwa|ios_pwa|android_native|ios_native|zebra
    device_model    TEXT,
    manufacturer    TEXT,
    os_version      TEXT,
    app_version     TEXT,
    user_agent_raw  TEXT,
    screen_px       TEXT,
    enrolled_ts     TEXT,
    storage_quota_bytes  INTEGER,   -- what the platform granted us
    storage_persisted    INTEGER    -- navigator.storage.persist() result
);

-- ---------------------------------------------------------------------------
-- Outbox: one new entity type, no schema change.
--   'defect_ack'  priority 45 -- small, useful, never competes with data.
-- Recorded here rather than in code comments so the priority table in
-- SYNC_CONTRACT stays the single source of truth.
-- ---------------------------------------------------------------------------
