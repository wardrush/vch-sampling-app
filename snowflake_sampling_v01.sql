-- ============================================================================
-- VCH_GEO :: SAMPLING subject area -- v01
-- 2026-08-16 -- Viridi Data
--
-- Conventions inherited from the existing VCH_GEO build. Do not deviate:
--   * Schemas RAW / REF / CURATED / META
--   * Provenance columns auto-populated, never typed by a human
--   * Upsert-never-delete; corrections are new rows carrying SUPERSEDES_*
--   * ROW_HASH on every curated table
--   * Bad input degrades (TRY_TO_*), it does not fail the batch
--   * Identifiers treated as possibly unstable; natural-key fallback preserved
--
-- Companion docs: docs/SAMPLING_SCHEMA_v01.md, docs/SYNC_CONTRACT_v01.md
-- ============================================================================

USE DATABASE VCH_GEO;

-- ============================================================================
-- RAW -- verbatim device payloads. Never edited, never overwritten.
-- ============================================================================

CREATE TABLE IF NOT EXISTS RAW.SYNC_PAYLOAD (
    RAW_PAYLOAD_HASH    VARCHAR(64)   NOT NULL PRIMARY KEY,   -- SHA-256 of the body
    DEVICE_ID           VARCHAR(64),
    SYNC_BATCH_ID       VARCHAR(64),
    PAYLOAD             VARIANT       NOT NULL,
    PAYLOAD_BYTES       NUMBER(12,0),
    SCHEMA_VERSION      VARCHAR(16),
    APP_VERSION         VARCHAR(32),
    RECEIVED_TS         TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LOAD_TS             TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LOADED_BY           VARCHAR(128)  DEFAULT CURRENT_USER()
);

CREATE TABLE IF NOT EXISTS RAW.MEDIA_UPLOAD_LOG (
    CONTENT_HASH        VARCHAR(64)   NOT NULL,
    MEDIA_ID            VARCHAR(64),
    DEVICE_ID           VARCHAR(64),
    OBJECT_KEY          VARCHAR(512),
    BYTES               NUMBER(12,0),
    UPLOAD_STARTED_TS   TIMESTAMP_NTZ,
    UPLOAD_COMPLETED_TS TIMESTAMP_NTZ,
    UPLOAD_STATE        VARCHAR(16),
    LOAD_TS             TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LOADED_BY           VARCHAR(128)  DEFAULT CURRENT_USER()
);

-- ============================================================================
-- REF -- reference data. Versioned, effective-dated, pushed to devices.
-- ============================================================================

CREATE TABLE IF NOT EXISTS REF.PROJECT_SAMPLING_SPEC (
    SPEC_ID                  VARCHAR(64)  NOT NULL PRIMARY KEY,
    PROJECT_ID               VARCHAR(64)  NOT NULL,
    PROTOCOL_VERSION         VARCHAR(16)  NOT NULL,      -- e.g. 'BCARBON_V3.0'
    PERIOD_CODE              VARCHAR(8)   NOT NULL,      -- S25 | F25 | S26 ...
    -- depth, per BCarbon v3.0: same interval at baseline and true-up
    DEPTH_TOP_CM             NUMBER(5,1)  NOT NULL,
    DEPTH_BOTTOM_CM          NUMBER(5,1)  NOT NULL,
    DEPTH_INCREMENTS_JSON    VARIANT,                    -- [[0,15],[15,30]]
    OVERDRILL_CM             NUMBER(4,1)  DEFAULT 5,
    -- compositing, per BCarbon v3.0: 5-10 cores within a <=2 m radius
    CORES_PER_COMPOSITE_MIN  NUMBER(3,0)  DEFAULT 5,
    CORES_PER_COMPOSITE_MAX  NUMBER(3,0)  DEFAULT 10,
    COMPOSITE_RADIUS_M       NUMBER(4,1)  DEFAULT 2,
    BD_CORE_REQUIRED         BOOLEAN      DEFAULT TRUE,
    BAG_SCHEME               VARCHAR(32)  DEFAULT 'ONE_BAG_PER_POINT',
                                          -- ONE_BAG_PER_POINT | POINT_X_TYPE
                                          -- | POINT_X_DEPTH_X_TYPE
    -- capture gates
    REQUIRED_MEDIA_ROLES     ARRAY,       -- ['label_photo','core_photo','site_photo']
    GPS_ACCURACY_REQUIRED_M  NUMBER(5,1)  DEFAULT 10,
    MIN_GPS_FIX_COUNT        NUMBER(3,0)  DEFAULT 3,
    MAX_PLAN_OFFSET_M_WARN   NUMBER(6,1)  DEFAULT 15,
    MAX_PLAN_OFFSET_M_BLOCK  NUMBER(6,1)  DEFAULT 30,
    DEFAULT_LAB_ID           VARCHAR(32),
    -- lifecycle
    EFFECTIVE_START          DATE         NOT NULL,
    EFFECTIVE_END            DATE,
    LOAD_TS                  TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LOADED_BY                VARCHAR(128)  DEFAULT CURRENT_USER(),
    LAST_UPDATED_TS          TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LAST_UPDATED_BY          VARCHAR(128)  DEFAULT CURRENT_USER(),
    ROW_HASH                 VARCHAR(64)
);

CREATE TABLE IF NOT EXISTS REF.CONDITION_CODE (
    CONDITION_CODE      VARCHAR(48)  NOT NULL,
    CODE_SET_VERSION    VARCHAR(16)  NOT NULL,
    CONDITION_GROUP     VARCHAR(48),          -- moisture | residue | crop | access | soil
    DISPLAY_LABEL       VARCHAR(128),
    VALUE_TYPE          VARCHAR(16),          -- none | band | number | text
    VALUE_OPTIONS       ARRAY,
    SORT_ORDER          NUMBER(4,0),
    IS_ACTIVE           BOOLEAN DEFAULT TRUE,
    LOAD_TS             TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LOADED_BY           VARCHAR(128)  DEFAULT CURRENT_USER(),
    PRIMARY KEY (CONDITION_CODE, CODE_SET_VERSION)
);

CREATE TABLE IF NOT EXISTS REF.DEVIATION_REASON (
    DEVIATION_REASON_CODE VARCHAR(48) NOT NULL PRIMARY KEY,
    DISPLAY_LABEL         VARCHAR(128),
    REQUIRES_NOTE         BOOLEAN DEFAULT FALSE,
    REQUIRES_PHOTO        BOOLEAN DEFAULT FALSE,
    IS_SKIP_REASON        BOOLEAN DEFAULT FALSE,  -- true = plan point produced no sample
    IS_ACTIVE             BOOLEAN DEFAULT TRUE,
    LOAD_TS               TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LOADED_BY             VARCHAR(128)  DEFAULT CURRENT_USER()
);

CREATE TABLE IF NOT EXISTS REF.DEFECT_CODE (
    DEFECT_CODE         VARCHAR(48) NOT NULL PRIMARY KEY,
    DISPLAY_LABEL       VARCHAR(160),
    DEFAULT_SEVERITY    VARCHAR(16),   -- blocking | review | advisory
    RAISED_BY           VARCHAR(16),   -- device | server_rule | analyst
    RULE_DESCRIPTION    VARCHAR(512),
    IS_ACTIVE           BOOLEAN DEFAULT TRUE,
    LOAD_TS             TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LOADED_BY           VARCHAR(128)  DEFAULT CURRENT_USER()
);

CREATE TABLE IF NOT EXISTS REF.LAB (
    LAB_ID              VARCHAR(32) NOT NULL PRIMARY KEY,
    LAB_NAME            VARCHAR(128),
    BARCODE_SYMBOLOGY   VARCHAR(48),   -- populate once Agidata confirms; nullable by design
    BARCODE_PATTERN     VARCHAR(256),  -- regex for format screening, advisory only
    BARCODE_REUSED      BOOLEAN,       -- drives the lab-join date window
    IS_ACTIVE           BOOLEAN DEFAULT TRUE,
    LOAD_TS             TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LOADED_BY           VARCHAR(128)  DEFAULT CURRENT_USER()
);

-- ============================================================================
-- CURATED -- the plan
-- ============================================================================

CREATE TABLE IF NOT EXISTS CURATED.SAMPLE_PLAN (
    PLAN_ID             VARCHAR(64) NOT NULL PRIMARY KEY,
    BOUNDARY_ID         VARCHAR(64) NOT NULL,
    SPEC_ID             VARCHAR(64) NOT NULL,
    PERIOD_CODE         VARCHAR(8)  NOT NULL,
    PLAN_VERSION        NUMBER(4,0) DEFAULT 1,
    PARENT_PLAN_ID      VARCHAR(64),
    STATUS              VARCHAR(16) DEFAULT 'draft',  -- draft|released|superseded
    POINT_COUNT         NUMBER(6,0),
    GENERATION_METHOD   VARCHAR(64),   -- 'stratas_v?' | 'manual' | 'prior_period_copy'
    RELEASED_TS         TIMESTAMP_NTZ,
    RELEASED_BY         VARCHAR(128),
    LOAD_TS             TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LOADED_BY           VARCHAR(128)  DEFAULT CURRENT_USER(),
    LAST_UPDATED_TS     TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LAST_UPDATED_BY     VARCHAR(128)  DEFAULT CURRENT_USER(),
    ROW_HASH            VARCHAR(64)
);

CREATE TABLE IF NOT EXISTS CURATED.SAMPLE_PLAN_POINT (
    PLAN_POINT_ID       VARCHAR(64) NOT NULL PRIMARY KEY,
    PLAN_ID             VARCHAR(64) NOT NULL,
    PLAN_POINT_LABEL    VARCHAR(64),          -- successor to Soil Strat Point ID
    PLANNED_LAT         NUMBER(11,8) NOT NULL,
    PLANNED_LON         NUMBER(12,8) NOT NULL,
    PLANNED_GEOG        GEOGRAPHY,            -- TRY_TO_GEOGRAPHY, degrade-not-fail
    STRATA_LABEL        VARCHAR(64),          -- e.g. 'D3_Silty Clay'
    STRATIFICATION_METHOD VARCHAR(32),        -- texture | density | geography
    ELEVATION_CLASS     VARCHAR(8),           -- A_high | B_low | NULL
    PRIOR_SAMPLE_UID    VARCHAR(64),          -- true-up link; navigated in v2
    SEQUENCE_NO         NUMBER(6,0),
    ACCESS_NOTE         VARCHAR(512),
    LOAD_TS             TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LOADED_BY           VARCHAR(128)  DEFAULT CURRENT_USER(),
    LAST_UPDATED_TS     TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LAST_UPDATED_BY     VARCHAR(128)  DEFAULT CURRENT_USER(),
    ROW_HASH            VARCHAR(64)
);

-- ============================================================================
-- CURATED -- capture
-- ============================================================================

CREATE TABLE IF NOT EXISTS CURATED.DEVICE (
    DEVICE_ID           VARCHAR(64) NOT NULL PRIMARY KEY,
    CREW_ORG_ID         VARCHAR(64),
    DEVICE_LABEL        VARCHAR(128),
    PLATFORM            VARCHAR(32),  -- android_pwa|ios_pwa|android_native|ios_native|zebra
    OS_VERSION          VARCHAR(48),
    APP_VERSION         VARCHAR(32),
    IS_MANAGED          BOOLEAN DEFAULT FALSE,   -- FALSE for BYOD contracted crew
    ENROLLED_TS         TIMESTAMP_NTZ,
    ENROLLED_BY         VARCHAR(128),
    LAST_SEEN_TS        TIMESTAMP_NTZ,
    REVOKED_TS          TIMESTAMP_NTZ,
    REVOKED_REASON      VARCHAR(256),
    LOAD_TS             TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LOADED_BY           VARCHAR(128)  DEFAULT CURRENT_USER(),
    LAST_UPDATED_TS     TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LAST_UPDATED_BY     VARCHAR(128)  DEFAULT CURRENT_USER()
);

CREATE TABLE IF NOT EXISTS CURATED.SYNC_BATCH (
    SYNC_BATCH_ID       VARCHAR(64) NOT NULL PRIMARY KEY,  -- client-generated
    DEVICE_ID           VARCHAR(64) NOT NULL,
    CLIENT_SENT_TS      TIMESTAMP_NTZ,
    SERVER_RECEIVED_TS  TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    RECORD_COUNT        NUMBER(8,0),
    ACCEPTED_COUNT      NUMBER(8,0),
    REJECTED_COUNT      NUMBER(8,0),
    RAW_PAYLOAD_HASH    VARCHAR(64),
    APP_VERSION         VARCHAR(32),
    SCHEMA_VERSION      VARCHAR(16),
    LOAD_TS             TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LOADED_BY           VARCHAR(128)  DEFAULT CURRENT_USER()
);

CREATE TABLE IF NOT EXISTS CURATED.FIELD_VISIT (
    VISIT_ID                  VARCHAR(64) NOT NULL PRIMARY KEY,  -- UUIDv7, device
    BOUNDARY_ID               VARCHAR(64) NOT NULL,
    PLAN_ID                   VARCHAR(64),
    SPEC_ID                   VARCHAR(64),
    CREW_ORG_ID               VARCHAR(64),
    SAMPLER_PERSON_ID         VARCHAR(64),
    DEVICE_ID                 VARCHAR(64),
    ACCESS_CONTACT_PERSON_ID  VARCHAR(64),   -- owner, operator, OR named manager
    VISIT_DATE                DATE,
    STARTED_TS                TIMESTAMP_NTZ,
    ENDED_TS                  TIMESTAMP_NTZ,
    STATUS                    VARCHAR(16) DEFAULT 'in_progress',
    ABANDON_REASON_CODE       VARCHAR(48),
    VISIT_NOTE                VARCHAR(1024),
    IS_PILOT                  BOOLEAN DEFAULT FALSE,  -- fall 2026 pilot marker;
                                        -- pilot data lands in production, tagged,
                                        -- rather than in a schema needing migration
    APP_VERSION               VARCHAR(32),
    SYNC_BATCH_ID             VARCHAR(64),
    LOAD_TS                   TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LOADED_BY                 VARCHAR(128)  DEFAULT CURRENT_USER(),
    LAST_UPDATED_TS           TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LAST_UPDATED_BY           VARCHAR(128)  DEFAULT CURRENT_USER(),
    ROW_HASH                  VARCHAR(64)
);

CREATE TABLE IF NOT EXISTS CURATED.SAMPLE_POINT (
    SAMPLE_UID              VARCHAR(64)  NOT NULL PRIMARY KEY,  -- UUIDv7 at capture
    VISIT_ID                VARCHAR(64)  NOT NULL,
    PLAN_POINT_ID           VARCHAR(64),          -- NULL = field-added sample
    BOUNDARY_ID             VARCHAR(64),          -- server-side point-in-polygon
    -- position, captured at the moment of sampling
    LAT                     NUMBER(11,8),
    LON                     NUMBER(12,8),
    GEOG                    GEOGRAPHY,            -- TRY_TO_GEOGRAPHY
    GEOG_VALID              BOOLEAN,
    GPS_ACCURACY_M          NUMBER(7,2),
    ALTITUDE_M              NUMBER(8,2),
    ALTITUDE_ACCURACY_M     NUMBER(7,2),
    POSITION_PROVIDER       VARCHAR(32),          -- gps | fused | network
    POSITION_SOURCE         VARCHAR(24),          -- gps | manual_map_pin | plan_inherited
    FIX_COUNT               NUMBER(4,0),
    FIX_SPREAD_M            NUMBER(7,2),
    -- deviation from plan, computed server-side in one place
    OFFSET_FROM_PLAN_M      NUMBER(9,2),
    BEARING_FROM_PLAN_DEG   NUMBER(5,1),
    DEVIATION_REASON_CODE   VARCHAR(48),
    -- time, device and server both preserved
    CAPTURED_TS_DEVICE      TIMESTAMP_NTZ,
    CAPTURED_TS_UTC_OFFSET  NUMBER(4,0),
    DEVICE_UPTIME_MS        NUMBER(15,0),         -- monotonic; exposes clock changes
    SYNCED_TS               TIMESTAMP_NTZ,
    SERVER_RECEIVED_TS      TIMESTAMP_NTZ,
    -- attribution
    SAMPLER_PERSON_ID       VARCHAR(64),
    DEVICE_ID               VARCHAR(64),
    SYNC_BATCH_ID           VARCHAR(64),
    -- protocol, denormalized so the spec in force at capture survives supersession
    PERIOD_CODE             VARCHAR(8),
    SPEC_ID                 VARCHAR(64),
    PROTOCOL_VERSION        VARCHAR(16),
    -- exception capture only; depth and core count default from the spec
    DEPTH_ACHIEVED_CM       NUMBER(5,1),
    REFUSAL_CODE            VARCHAR(48),
    CORES_TAKEN             NUMBER(3,0),          -- NULL = per spec
    BD_CORE_TAKEN           BOOLEAN,
    -- derived
    TRS_CANONICAL           VARCHAR(32),          -- server-derived, NEVER typed
    -- lifecycle
    REVIEW_STATE            VARCHAR(24) DEFAULT 'captured',
    SUPERSEDES_SAMPLE_UID   VARCHAR(64),
    NOTE                    VARCHAR(1024),
    LOAD_TS                 TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LOADED_BY               VARCHAR(128)  DEFAULT CURRENT_USER(),
    LAST_UPDATED_TS         TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LAST_UPDATED_BY         VARCHAR(128)  DEFAULT CURRENT_USER(),
    ROW_HASH                VARCHAR(64)
);

CREATE TABLE IF NOT EXISTS CURATED.SAMPLE_BAG (
    BAG_ID                  VARCHAR(64) NOT NULL PRIMARY KEY,  -- UUIDv7, device
    SAMPLE_UID              VARCHAR(64) NOT NULL,
    BAG_SEQ                 NUMBER(3,0) DEFAULT 1,             -- 1 in v1
    BAG_ROLE                VARCHAR(24) DEFAULT 'composite',
                                        -- composite|bulk_density|duplicate_qc|blank
    DEPTH_TOP_CM            NUMBER(5,1),        -- defaults from spec
    DEPTH_BOTTOM_CM         NUMBER(5,1),
    LAB_ID                  VARCHAR(32),
    BARCODE_RAW             VARCHAR(256),       -- VERBATIM. Never normalized in place
    BARCODE_NORM            VARCHAR(256),       -- derived column, rebuildable
    BARCODE_SYMBOLOGY       VARCHAR(48),        -- reported by the scanner
    BARCODE_CAPTURE_METHOD  VARCHAR(24),        -- scan|manual_entry|photo_recovered
    BARCODE_SCANNED_TS      TIMESTAMP_NTZ,
    BARCODE_DUPLICATE_FLAG  BOOLEAN DEFAULT FALSE,
    SHIPMENT_ID             VARCHAR(64),        -- nullable; v2
    VOID_FLAG               BOOLEAN DEFAULT FALSE,
    VOID_REASON_CODE        VARCHAR(48),
    SYNC_BATCH_ID           VARCHAR(64),
    LOAD_TS                 TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LOADED_BY               VARCHAR(128)  DEFAULT CURRENT_USER(),
    LAST_UPDATED_TS         TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LAST_UPDATED_BY         VARCHAR(128)  DEFAULT CURRENT_USER(),
    ROW_HASH                VARCHAR(64)
);

CREATE TABLE IF NOT EXISTS CURATED.SAMPLE_CONDITION (
    CONDITION_ID        VARCHAR(64) NOT NULL PRIMARY KEY,
    SAMPLE_UID          VARCHAR(64) NOT NULL,
    CONDITION_CODE      VARCHAR(48) NOT NULL,
    CONDITION_VALUE     VARCHAR(128),
    CODE_SET_VERSION    VARCHAR(16),
    SYNC_BATCH_ID       VARCHAR(64),
    LOAD_TS             TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LOADED_BY           VARCHAR(128)  DEFAULT CURRENT_USER()
);

-- Media is deliberately NOT 1:1 with samples. At least one of the three
-- parent keys must be non-null; a blocked-approach photo belongs to the
-- visit, not to any hole. (SAMPLE_UID, MEDIA_ROLE) is intentionally not unique.
CREATE TABLE IF NOT EXISTS CURATED.MEDIA (
    MEDIA_ID            VARCHAR(64) NOT NULL PRIMARY KEY,  -- UUIDv7, device
    CONTENT_HASH        VARCHAR(64) NOT NULL,              -- SHA-256, addresses store
    SAMPLE_UID          VARCHAR(64),
    BAG_ID              VARCHAR(64),
    VISIT_ID            VARCHAR(64),
    MEDIA_ROLE          VARCHAR(32),  -- label_photo|core_photo|site_photo|issue_photo|other
    IS_REQUIRED_ROLE    BOOLEAN DEFAULT FALSE,
    CAPTURE_ORDER       NUMBER(4,0),
    CAPTURE_TS_DEVICE   TIMESTAMP_NTZ,
    EXIF_LAT            NUMBER(11,8),   -- preserved verbatim; independent corroboration
    EXIF_LON            NUMBER(12,8),
    EXIF_TS             TIMESTAMP_NTZ,
    EXIF_RAW            VARIANT,
    BYTES               NUMBER(12,0),
    WIDTH_PX            NUMBER(6,0),
    HEIGHT_PX           NUMBER(6,0),
    MIME_TYPE           VARCHAR(64),
    OBJECT_KEY          VARCHAR(512),
    UPLOAD_STATE        VARCHAR(16) DEFAULT 'pending',
    UPLOADED_TS         TIMESTAMP_NTZ,
    SYNC_BATCH_ID       VARCHAR(64),
    LOAD_TS             TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LOADED_BY           VARCHAR(128)  DEFAULT CURRENT_USER(),
    LAST_UPDATED_TS     TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LAST_UPDATED_BY     VARCHAR(128)  DEFAULT CURRENT_USER(),
    ROW_HASH            VARCHAR(64),
    CONSTRAINT MEDIA_HAS_PARENT CHECK (
        SAMPLE_UID IS NOT NULL OR BAG_ID IS NOT NULL OR VISIT_ID IS NOT NULL
    )
);

CREATE TABLE IF NOT EXISTS CURATED.SAMPLE_DEFECT (
    DEFECT_ID           VARCHAR(64) NOT NULL PRIMARY KEY,
    SAMPLE_UID          VARCHAR(64),
    BAG_ID              VARCHAR(64),
    VISIT_ID            VARCHAR(64),
    PLAN_POINT_ID       VARCHAR(64),   -- for PLAN_POINT_UNSAMPLED
    DEFECT_CODE         VARCHAR(48) NOT NULL,
    SEVERITY            VARCHAR(16),
    DETECTED_BY         VARCHAR(16),   -- device | server_rule | analyst
    DETECTED_TS         TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    DETAIL              VARCHAR(1024),
    RESOLUTION_STATE    VARCHAR(24) DEFAULT 'open',
    RESOLVED_BY         VARCHAR(128),
    RESOLVED_TS         TIMESTAMP_NTZ,
    RESOLUTION_NOTE     VARCHAR(1024),
    LOAD_TS             TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LOADED_BY           VARCHAR(128)  DEFAULT CURRENT_USER(),
    LAST_UPDATED_TS     TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LAST_UPDATED_BY     VARCHAR(128)  DEFAULT CURRENT_USER()
);

-- ============================================================================
-- CURATED -- custody. STUB. Tables exist so the seam is designed; no v1 UI.
-- ============================================================================

CREATE TABLE IF NOT EXISTS CURATED.SHIPMENT (
    SHIPMENT_ID         VARCHAR(64) NOT NULL PRIMARY KEY,
    CREW_ORG_ID         VARCHAR(64),
    LAB_ID              VARCHAR(32),
    CARRIER             VARCHAR(64),
    TRACKING_NUMBER     VARCHAR(128),
    SHIPPED_TS          TIMESTAMP_NTZ,
    RECEIVED_TS         TIMESTAMP_NTZ,
    BAG_COUNT_DECLARED  NUMBER(6,0),
    BAG_COUNT_RECEIVED  NUMBER(6,0),
    STATUS              VARCHAR(24),
    LOAD_TS             TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LOADED_BY           VARCHAR(128)  DEFAULT CURRENT_USER()
);

CREATE TABLE IF NOT EXISTS CURATED.SHIPMENT_BAG (
    SHIPMENT_ID         VARCHAR(64) NOT NULL,
    BAG_ID              VARCHAR(64) NOT NULL,
    SCANNED_TS          TIMESTAMP_NTZ,
    SCANNED_BY          VARCHAR(128),
    LOAD_TS             TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    LOADED_BY           VARCHAR(128)  DEFAULT CURRENT_USER(),
    PRIMARY KEY (SHIPMENT_ID, BAG_ID)
);

-- ============================================================================
-- Server-side derivations. Run after each sync batch lands.
-- Every one of these is computed in ONE place so there is ONE answer.
-- ============================================================================

-- 1. Point-in-polygon -> BOUNDARY_ID, and the outside-boundary defect.
--    Flags, never drops. A point 20 m outside a boundary is usually a
--    boundary problem, and the analyst queue is where that gets decided.
CREATE OR REPLACE PROCEDURE CURATED.SP_RESOLVE_SAMPLE_BOUNDARY(BATCH_ID VARCHAR)
RETURNS VARCHAR LANGUAGE SQL AS
$$
BEGIN
  UPDATE CURATED.SAMPLE_POINT sp
     SET BOUNDARY_ID = b.BOUNDARY_ID,
         LAST_UPDATED_TS = CURRENT_TIMESTAMP()
    FROM CURATED.BOUNDARY b
   WHERE sp.SYNC_BATCH_ID = :BATCH_ID
     AND sp.BOUNDARY_ID IS NULL
     AND b.STATUS = 'active'
     AND ST_WITHIN(sp.GEOG, b.GEOG);
  RETURN 'ok';
END;
$$;

-- 2. Offset from plan, in metres, computed here and nowhere else.
CREATE OR REPLACE VIEW CURATED.V_SAMPLE_PLAN_OFFSET AS
SELECT sp.SAMPLE_UID,
       sp.PLAN_POINT_ID,
       ST_DISTANCE(sp.GEOG, pp.PLANNED_GEOG) AS OFFSET_FROM_PLAN_M,
       spec.MAX_PLAN_OFFSET_M_WARN,
       spec.MAX_PLAN_OFFSET_M_BLOCK
  FROM CURATED.SAMPLE_POINT sp
  JOIN CURATED.SAMPLE_PLAN_POINT pp ON pp.PLAN_POINT_ID = sp.PLAN_POINT_ID
  LEFT JOIN REF.PROJECT_SAMPLING_SPEC spec ON spec.SPEC_ID = sp.SPEC_ID;

-- 3. The analyst queue. This view IS the product for the office side.
CREATE OR REPLACE VIEW CURATED.V_SAMPLE_REVIEW_QUEUE AS
SELECT d.DEFECT_ID,
       d.DEFECT_CODE,
       d.SEVERITY,
       d.DETECTED_TS,
       d.DETAIL,
       sp.SAMPLE_UID,
       sp.LAT, sp.LON, sp.GPS_ACCURACY_M, sp.POSITION_SOURCE,
       sp.OFFSET_FROM_PLAN_M, sp.DEVIATION_REASON_CODE,
       sp.CAPTURED_TS_DEVICE, sp.REVIEW_STATE,
       v.VISIT_DATE, v.SAMPLER_PERSON_ID, v.CREW_ORG_ID, v.BOUNDARY_ID,
       pp.PLAN_POINT_LABEL, pp.STRATA_LABEL,
       bag.BARCODE_RAW, bag.BARCODE_CAPTURE_METHOD, bag.BARCODE_DUPLICATE_FLAG,
       (SELECT COUNT(*) FROM CURATED.MEDIA m WHERE m.SAMPLE_UID = sp.SAMPLE_UID)
         AS MEDIA_COUNT
  FROM CURATED.SAMPLE_DEFECT d
  LEFT JOIN CURATED.SAMPLE_POINT      sp  ON sp.SAMPLE_UID  = d.SAMPLE_UID
  LEFT JOIN CURATED.FIELD_VISIT       v   ON v.VISIT_ID     = sp.VISIT_ID
  LEFT JOIN CURATED.SAMPLE_PLAN_POINT pp  ON pp.PLAN_POINT_ID = sp.PLAN_POINT_ID
  LEFT JOIN CURATED.SAMPLE_BAG        bag ON bag.SAMPLE_UID = sp.SAMPLE_UID
 WHERE d.RESOLUTION_STATE = 'open';

-- 4. Plan completion -- what has NOT been sampled is as important as what has.
CREATE OR REPLACE VIEW CURATED.V_PLAN_COMPLETION AS
SELECT p.PLAN_ID,
       p.BOUNDARY_ID,
       p.PERIOD_CODE,
       p.POINT_COUNT                                AS PLANNED_POINTS,
       COUNT(DISTINCT sp.PLAN_POINT_ID)             AS PLAN_POINTS_SAMPLED,
       COUNT(sp.SAMPLE_UID)                         AS SAMPLES_CAPTURED,
       SUM(IFF(sp.PLAN_POINT_ID IS NULL, 1, 0))     AS FIELD_ADDED_SAMPLES,
       p.POINT_COUNT - COUNT(DISTINCT sp.PLAN_POINT_ID) AS PLAN_POINTS_OUTSTANDING
  FROM CURATED.SAMPLE_PLAN p
  LEFT JOIN CURATED.SAMPLE_PLAN_POINT pp ON pp.PLAN_ID = p.PLAN_ID
  LEFT JOIN CURATED.SAMPLE_POINT sp      ON sp.PLAN_POINT_ID = pp.PLAN_POINT_ID
 WHERE p.STATUS = 'released'
 GROUP BY p.PLAN_ID, p.BOUNDARY_ID, p.PERIOD_CODE, p.POINT_COUNT;

-- 5. The lab join. The barcode is an attribute, never the key.
--    Date window guards against cross-season barcode reuse; set the window
--    from REF.LAB.BARCODE_REUSED once Agidata confirms their policy.
CREATE OR REPLACE VIEW CURATED.V_BAG_LAB_MATCH AS
SELECT bag.BAG_ID,
       bag.SAMPLE_UID,
       lr.LAB_RESULT_ID,
       lr.TOC_PCT, lr.TC_PCT, lr.CCE_PCT, lr.BULK_DENSITY_G_CM3, lr.OM_PCT,
       CASE
         WHEN lr.LAB_RESULT_ID IS NULL                       THEN 'unmatched'
         WHEN bag.BARCODE_CAPTURE_METHOD = 'photo_recovered' THEN 'corrected'
         WHEN bag.BARCODE_DUPLICATE_FLAG                     THEN 'partial'
         ELSE 'full'
       END AS MATCH_STATUS
  FROM CURATED.SAMPLE_BAG bag
  LEFT JOIN CURATED.LAB_RESULT lr
         ON lr.LAB_ID = bag.LAB_ID
        AND lr.LAB_BARCODE = bag.BARCODE_NORM
        AND lr.RECEIVED_DATE BETWEEN bag.BARCODE_SCANNED_TS::DATE
                                 AND DATEADD(DAY, 120, bag.BARCODE_SCANNED_TS::DATE)
 WHERE bag.VOID_FLAG = FALSE;
