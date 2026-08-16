-- ============================================================================
-- VCH_GEO :: SAMPLING subject area -- v02 ADDENDUM
-- 2026-08-16 -- Viridi Data
--
-- Deploy ON TOP OF ddl/snowflake_sampling_v01.sql. CREATE + ALTER only;
-- nothing in v01 is replaced. Same VCH_GEO conventions throughout.
--
-- Drivers for these changes:
--   1. Plan-point ingest tool (Thane's upload surface)
--   2. Netlify hosting (nothing schema-level, but the token/session model)
--   3. Audit gaps found writing the addendum -- capture_source is the big one
--   4. Defect down-sync to the field
--
-- The nightly-sync assumption changed NOTHING here. Recorded so nobody looks.
-- Companion: docs/SCHEMA_AND_SYNC_ADDENDUM_v02.md
-- ============================================================================

USE DATABASE VCH_GEO;

-- ============================================================================
-- RAW -- the uploaded file, verbatim. Same discipline as raw lab files.
-- ============================================================================

CREATE TABLE IF NOT EXISTS RAW.PLAN_IMPORT_FILE (
    CONTENT_HASH        VARCHAR(64)  NOT NULL PRIMARY KEY,  -- SHA-256
    ORIGINAL_FILENAME   VARCHAR(512),
    MIME_TYPE           VARCHAR(128),
    BYTES               NUMBER(12,0),
    SOURCE_KIND         VARCHAR(24),   -- file_upload | clipboard_paste
    BLOB_KEY            VARCHAR(512),  -- Netlify Blobs key (or S3 key post-MVP)
    RAW_TEXT            VARCHAR,       -- populated for clipboard_paste
    UPLOADED_BY         VARCHAR(128),
    UPLOADED_TS         TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LOAD_TS             TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LOADED_BY           VARCHAR(128)  DEFAULT CURRENT_USER()
);

-- ============================================================================
-- CURATED -- the import event and its rows
-- ============================================================================

CREATE TABLE IF NOT EXISTS CURATED.PLAN_IMPORT (
    IMPORT_ID           VARCHAR(64) NOT NULL PRIMARY KEY,
    CONTENT_HASH        VARCHAR(64) NOT NULL,
    IMPORTED_BY         VARCHAR(128) NOT NULL,
    IMPORTED_TS         TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    SOURCE_KIND         VARCHAR(24),
    ORIGINAL_FILENAME   VARCHAR(512),
    SHEET_NAME          VARCHAR(128),
    MAPPING_JSON        VARIANT,       -- resolved column mapping; makes the
                                       -- import reproducible from the raw file
    PERIOD_CODE         VARCHAR(8),
    PROJECT_ID          VARCHAR(64),
    ROW_COUNT           NUMBER(8,0),
    ROWS_COMMITTED      NUMBER(8,0),
    ROWS_FLAGGED        NUMBER(8,0),
    ROWS_BLOCKED        NUMBER(8,0),
    PLAN_IDS            ARRAY,         -- plans created or revised
    STATUS              VARCHAR(16) DEFAULT 'staged',  -- staged|committed|retired
    RETIRED_BY          VARCHAR(128),
    RETIRED_TS          TIMESTAMP_NTZ,
    RETIRE_REASON       VARCHAR(512),
    LOAD_TS             TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LOADED_BY           VARCHAR(128)  DEFAULT CURRENT_USER(),
    LAST_UPDATED_TS     TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LAST_UPDATED_BY     VARCHAR(128)  DEFAULT CURRENT_USER(),
    ROW_HASH            VARCHAR(64)
);

-- One row per INPUT row, INCLUDING blocked ones. An import that silently
-- dropped five rows is an import nobody can audit.
CREATE TABLE IF NOT EXISTS CURATED.PLAN_IMPORT_ROW (
    IMPORT_ROW_ID           VARCHAR(64) NOT NULL PRIMARY KEY,
    IMPORT_ID               VARCHAR(64) NOT NULL,
    SOURCE_ROW_NO           NUMBER(8,0),
    RAW_VALUES_JSON         VARIANT,        -- verbatim, pre-mapping
    -- mapped values
    PLAN_POINT_LABEL        VARCHAR(64),
    LAT_RAW                 VARCHAR(64),    -- exactly as supplied
    LON_RAW                 VARCHAR(64),
    LAT                     NUMBER(11,8),
    LON                     NUMBER(12,8),
    COORD_FORMAT_DETECTED   VARCHAR(16),    -- decimal | dms | unknown
    COORD_FIX_APPLIED       VARCHAR(32),    -- e.g. swap_lat_lon
    BOUNDARY_ID_STATED      VARCHAR(64),
    BOUNDARY_ID_RESOLVED    VARCHAR(64),    -- point-in-polygon
    FIELD_NAME              VARCHAR(256),
    STRATA_LABEL            VARCHAR(64),
    ELEVATION_CLASS         VARCHAR(8),
    SEQUENCE_NO             NUMBER(6,0),
    ACCESS_NOTE             VARCHAR(512),
    PRIOR_SAMPLE_UID        VARCHAR(64),
    EXTRA_JSON              VARIANT,        -- unmapped columns, PRESERVED
    -- CRM candidates. TEXT ONLY. An upload never creates a CRM record.
    OPERATION_TEXT          VARCHAR(256),
    OPERATION_MATCH_ID      VARCHAR(64),
    OPERATION_MATCH_SCORE   NUMBER(5,4),
    OPERATION_MATCH_STATUS  VARCHAR(24),    -- matched|suggested|unmatched|
                                            -- resolved_by_analyst
    CONTACT_NAME_TEXT       VARCHAR(256),
    CONTACT_PHONE_TEXT      VARCHAR(64),
    CONTACT_EMAIL_TEXT      VARCHAR(256),
    CONTACT_MATCH_ID        VARCHAR(64),
    CONTACT_MATCH_SCORE     NUMBER(5,4),
    CONTACT_MATCH_STATUS    VARCHAR(24),
    -- outcome
    ROW_STATUS              VARCHAR(16),    -- ready|flagged|blocked|committed|
                                            -- superseded
    VALIDATION_CODES        ARRAY,
    PLAN_POINT_ID           VARCHAR(64),    -- set on commit
    LOAD_TS                 TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LOADED_BY               VARCHAR(128)  DEFAULT CURRENT_USER(),
    LAST_UPDATED_TS         TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LAST_UPDATED_BY         VARCHAR(128)  DEFAULT CURRENT_USER(),
    ROW_HASH                VARCHAR(64)
);
CREATE INDEX IF NOT EXISTS IX_IMPORT_ROW_IMPORT ON CURATED.PLAN_IMPORT_ROW(IMPORT_ID);

-- ============================================================================
-- CURATED -- per-user memory. Makes upload #2 zero-click; gates the tutorial.
-- Server-side and NOT a cookie: a new laptop must not re-teach an experienced
-- user. That requirement is why the MVP needs soft identity at all.
-- ============================================================================

CREATE TABLE IF NOT EXISTS CURATED.IMPORT_PROFILE (
    PROFILE_ID              VARCHAR(64) NOT NULL PRIMARY KEY,
    PERSON_REF              VARCHAR(128) NOT NULL,  -- token identity (MVP),
                                                    -- person_id after IdP
    SURFACE                 VARCHAR(24),            -- ingest | sampler
    MAPPING_JSON            VARIANT,                -- last accepted mapping
    MAPPING_UPDATED_TS      TIMESTAMP_NTZ,
    TUTORIAL_COMPLETED_TS   TIMESTAMP_NTZ,
    TUTORIAL_SKIPPED_FLAG   BOOLEAN DEFAULT FALSE,
    DEFAULT_PERIOD_CODE     VARCHAR(8),
    DEFAULT_PROJECT_ID      VARCHAR(64),
    IMPORT_COUNT            NUMBER(8,0) DEFAULT 0,
    LOAD_TS                 TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LOADED_BY               VARCHAR(128)  DEFAULT CURRENT_USER(),
    LAST_UPDATED_TS         TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LAST_UPDATED_BY         VARCHAR(128)  DEFAULT CURRENT_USER()
);

-- ============================================================================
-- CURATED -- MVP auth. DROP THIS TABLE when the shared IdP lands.
-- A link is a bearer credential. Bounded to one trusted contractor and one
-- season, rotatable, revocable, and exchanged immediately for a signed
-- httpOnly session cookie -- which is what makes the IdP a swap, not a rewrite.
-- ============================================================================

CREATE TABLE IF NOT EXISTS CURATED.INGEST_ACCESS_TOKEN (
    TOKEN_ID            VARCHAR(64) NOT NULL PRIMARY KEY,
    TOKEN_HASH          VARCHAR(64) NOT NULL,   -- NEVER the token itself
    PERSON_REF          VARCHAR(128) NOT NULL,
    DISPLAY_NAME        VARCHAR(128),
    SURFACE             VARCHAR(24),            -- ingest | sampler_enroll
    CREW_ORG_ID         VARCHAR(64),
    ISSUED_BY           VARCHAR(128),
    ISSUED_TS           TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    EXPIRES_TS          TIMESTAMP_NTZ NOT NULL,
    REVOKED_TS          TIMESTAMP_NTZ,
    REVOKED_REASON      VARCHAR(256),
    LAST_USED_TS        TIMESTAMP_NTZ,
    USE_COUNT           NUMBER(8,0) DEFAULT 0,
    LOAD_TS             TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LOADED_BY           VARCHAR(128)  DEFAULT CURRENT_USER()
);

-- ============================================================================
-- CURATED -- actor log for the surfaces that are NOT the sampling app.
-- The app's own attribution lives on its rows; the office side needs
-- somewhere to write.
-- ============================================================================

CREATE TABLE IF NOT EXISTS CURATED.AUDIT_EVENT (
    EVENT_ID        VARCHAR(64) NOT NULL PRIMARY KEY,
    EVENT_TS        TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    ACTOR_REF       VARCHAR(128),
    ACTOR_KIND      VARCHAR(24),   -- token | idp_user | service
    SURFACE         VARCHAR(24),   -- ingest | analyst | admin | sync
    ACTION          VARCHAR(48),   -- import_commit | import_retire |
                                   -- defect_resolve | plan_release |
                                   -- device_enroll | device_revoke |
                                   -- token_issue | token_revoke
    ENTITY_TYPE     VARCHAR(48),
    ENTITY_ID       VARCHAR(64),
    DETAIL_JSON     VARIANT,
    IP_HASH         VARCHAR(64),   -- hashed, not stored raw
    USER_AGENT_RAW  VARCHAR(512),
    LOAD_TS         TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LOADED_BY       VARCHAR(128)  DEFAULT CURRENT_USER()
);

-- ============================================================================
-- ALTERs
-- ============================================================================

-- MEDIA: capture_source is the single most important audit distinction in
-- this table and it was missing from v01. A photograph picked from the camera
-- roll is not evidence of having been at the hole. Required roles accept
-- in_app_camera ONLY; gallery is permitted for issue_photo/other and is
-- permanently marked.
ALTER TABLE CURATED.MEDIA ADD COLUMN IF NOT EXISTS
    CAPTURE_SOURCE     VARCHAR(24) DEFAULT 'unknown';  -- in_app_camera |
                                                       -- device_gallery | unknown
ALTER TABLE CURATED.MEDIA ADD COLUMN IF NOT EXISTS
    DEVICE_ID          VARCHAR(64);   -- provenance stands alone
ALTER TABLE CURATED.MEDIA ADD COLUMN IF NOT EXISTS
    EXIF_GPS_PRESENT   BOOLEAN;       -- cheap; avoids unpacking EXIF_RAW

-- DEVICE: "an Android phone" is not a device record, and on a BYOD fleet
-- this table IS the fleet inventory.
ALTER TABLE CURATED.DEVICE ADD COLUMN IF NOT EXISTS DEVICE_MODEL   VARCHAR(128);
ALTER TABLE CURATED.DEVICE ADD COLUMN IF NOT EXISTS MANUFACTURER   VARCHAR(128);
ALTER TABLE CURATED.DEVICE ADD COLUMN IF NOT EXISTS USER_AGENT_RAW VARCHAR(512);

-- Plan provenance: "where did this point come from" should resolve to a row
-- in a spreadsheet with a content hash and a person's name on it.
-- Nullable -- a plan may still be authored by an analyst rather than uploaded.
ALTER TABLE CURATED.SAMPLE_PLAN       ADD COLUMN IF NOT EXISTS IMPORT_ID     VARCHAR(64);
ALTER TABLE CURATED.SAMPLE_PLAN_POINT ADD COLUMN IF NOT EXISTS IMPORT_ROW_ID VARCHAR(64);

-- Defect down-sync. Only defects a crew can ACT on are pushed to the field;
-- the rest stay in the office. Pushing down noise trains people to ignore
-- the list, which is worse than not having one.
ALTER TABLE CURATED.SAMPLE_DEFECT ADD COLUMN IF NOT EXISTS
    VISIBLE_TO_FIELD BOOLEAN DEFAULT FALSE;
ALTER TABLE CURATED.SAMPLE_DEFECT ADD COLUMN IF NOT EXISTS
    FIELD_ACKED_TS   TIMESTAMP_NTZ;   -- seen != resolved. Only an analyst resolves.

-- ============================================================================
-- Reference data seeds -- new codes introduced in v02
-- ============================================================================

INSERT INTO REF.DEFECT_CODE (DEFECT_CODE, DISPLAY_LABEL, DEFAULT_SEVERITY, RAISED_BY, RULE_DESCRIPTION)
SELECT 'MEDIA_GALLERY_SOURCED',
       'Required photo came from the camera roll, not the in-app camera',
       'review', 'server_rule',
       'MEDIA.CAPTURE_SOURCE = device_gallery on a role listed in the spec''s REQUIRED_MEDIA_ROLES. The app should prevent this; the rule catches the case where it did not.'
WHERE NOT EXISTS (SELECT 1 FROM REF.DEFECT_CODE WHERE DEFECT_CODE = 'MEDIA_GALLERY_SOURCED');

INSERT INTO REF.DEFECT_CODE (DEFECT_CODE, DISPLAY_LABEL, DEFAULT_SEVERITY, RAISED_BY, RULE_DESCRIPTION)
SELECT 'IMPORT_OPERATION_UNRESOLVED',
       'Uploaded operation name matched no existing operation',
       'review', 'server_rule',
       'PLAN_IMPORT_ROW.OPERATION_MATCH_STATUS = unmatched. An analyst decides whether this is a new operation or another spelling of an existing one. The upload never creates it.'
WHERE NOT EXISTS (SELECT 1 FROM REF.DEFECT_CODE WHERE DEFECT_CODE = 'IMPORT_OPERATION_UNRESOLVED');

INSERT INTO REF.DEFECT_CODE (DEFECT_CODE, DISPLAY_LABEL, DEFAULT_SEVERITY, RAISED_BY, RULE_DESCRIPTION)
SELECT 'IMPORT_CONTACT_UNRESOLVED',
       'Uploaded contact matched no existing person',
       'advisory', 'server_rule',
       'PLAN_IMPORT_ROW.CONTACT_MATCH_STATUS = unmatched.'
WHERE NOT EXISTS (SELECT 1 FROM REF.DEFECT_CODE WHERE DEFECT_CODE = 'IMPORT_CONTACT_UNRESOLVED');

-- Mark which existing codes a field crew can act on. Everything not listed
-- stays in the office: CLOCK_DRIFT_SUSPECTED, LATE_SYNC,
-- EXIF_POSITION_MISMATCH, MEDIA_GALLERY_SOURCED, MANUAL_POSITION.
CREATE TABLE IF NOT EXISTS REF.DEFECT_FIELD_VISIBILITY (
    DEFECT_CODE      VARCHAR(48) NOT NULL PRIMARY KEY,
    VISIBLE_TO_FIELD BOOLEAN,
    FIELD_GUIDANCE   VARCHAR(512),   -- plain language, shown on the phone
    LOAD_TS          TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LOADED_BY        VARCHAR(128)  DEFAULT CURRENT_USER()
);

-- ============================================================================
-- Views
-- ============================================================================

-- The ingest preview, server side. Everything the tool shows Thane.
-- NOTE: the PROPERTY join below assumes CURATED.BOUNDARY.PROPERTY_ID and
-- CURATED.PROPERTY.PROPERTY_NAME under the Phase 1 entity model. If the live
-- names are still the legacy FACT_BORDER ones, adjust here only.
CREATE OR REPLACE VIEW CURATED.V_IMPORT_PREVIEW AS
SELECT r.IMPORT_ID,
       r.SOURCE_ROW_NO,
       r.PLAN_POINT_LABEL,
       r.LAT,
       r.LON,
       r.COORD_FORMAT_DETECTED,
       r.COORD_FIX_APPLIED,
       r.BOUNDARY_ID_RESOLVED,
       p.PROPERTY_NAME              AS BOUNDARY_PROPERTY_NAME,
       b.GEOM_ACRES,
       r.OPERATION_TEXT,
       r.OPERATION_MATCH_STATUS,
       r.OPERATION_MATCH_SCORE,
       r.CONTACT_NAME_TEXT,
       r.CONTACT_MATCH_STATUS,
       r.ROW_STATUS,
       r.VALIDATION_CODES
  FROM CURATED.PLAN_IMPORT_ROW r
  LEFT JOIN CURATED.BOUNDARY b ON b.BOUNDARY_ID = r.BOUNDARY_ID_RESOLVED
  LEFT JOIN CURATED.PROPERTY p ON p.PROPERTY_ID = b.PROPERTY_ID;

-- What the field sees next morning. Only actionable codes, only recent work.
CREATE OR REPLACE VIEW CURATED.V_FIELD_DEFECT_FEED AS
SELECT d.DEFECT_ID,
       d.DEFECT_CODE,
       d.SEVERITY,
       d.DETECTED_TS,
       d.FIELD_ACKED_TS,
       fv.CREW_ORG_ID,
       fv.SAMPLER_PERSON_ID,
       fv.VISIT_DATE,
       sp.SAMPLE_UID, sp.LAT, sp.LON,
       pp.PLAN_POINT_LABEL,
       vis.FIELD_GUIDANCE
  FROM CURATED.SAMPLE_DEFECT d
  LEFT JOIN CURATED.SAMPLE_POINT      sp  ON sp.SAMPLE_UID = d.SAMPLE_UID
  LEFT JOIN CURATED.FIELD_VISIT       fv  ON fv.VISIT_ID   = sp.VISIT_ID
  LEFT JOIN CURATED.SAMPLE_PLAN_POINT pp  ON pp.PLAN_POINT_ID = sp.PLAN_POINT_ID
  LEFT JOIN REF.DEFECT_FIELD_VISIBILITY vis ON vis.DEFECT_CODE = d.DEFECT_CODE
 WHERE d.RESOLUTION_STATE = 'open'
   AND COALESCE(d.VISIBLE_TO_FIELD, vis.VISIBLE_TO_FIELD, FALSE) = TRUE
   AND fv.VISIT_DATE >= DATEADD(DAY, -5, CURRENT_DATE());

-- Import provenance, end to end: a sampled point back to a spreadsheet row.
CREATE OR REPLACE VIEW CURATED.V_POINT_PROVENANCE AS
SELECT sp.SAMPLE_UID,
       sp.CAPTURED_TS_DEVICE,
       sp.SAMPLER_PERSON_ID,
       sp.DEVICE_ID,
       pp.PLAN_POINT_LABEL,
       pp.PLANNED_LAT, pp.PLANNED_LON,
       sp.LAT, sp.LON, sp.OFFSET_FROM_PLAN_M, sp.DEVIATION_REASON_CODE,
       ir.SOURCE_ROW_NO,
       ir.RAW_VALUES_JSON,
       pi.ORIGINAL_FILENAME,
       pi.IMPORTED_BY,
       pi.IMPORTED_TS,
       pi.CONTENT_HASH
  FROM CURATED.SAMPLE_POINT sp
  LEFT JOIN CURATED.SAMPLE_PLAN_POINT pp ON pp.PLAN_POINT_ID = sp.PLAN_POINT_ID
  LEFT JOIN CURATED.PLAN_IMPORT_ROW   ir ON ir.IMPORT_ROW_ID = pp.IMPORT_ROW_ID
  LEFT JOIN CURATED.PLAN_IMPORT       pi ON pi.IMPORT_ID     = ir.IMPORT_ID;
