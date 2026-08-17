-- ============================================================================
-- VCH Sampling :: Netlify database (Neon Postgres) -- v01
-- 2026-08-17 -- Viridi Data
--
-- MVP/UAT storage. The Snowflake path stays fully intact behind SQL_BACKEND and
-- is where this goes in production; this file is ADDITIVE, not a migration.
-- Nothing in snowflake_sampling_v01.sql / _v02_addendum.sql / _v03_entity_compat
-- is edited or superseded.
--
-- APPLIED BY:  npx tsx tools/deploy-ddl.ts --target=postgres
--   Idempotent end to end -- CREATE ... IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
--   CREATE OR REPLACE VIEW, guarded seeds. Running it twice is indistinguishable
--   from running it once. The runner wraps the whole file in one transaction
--   behind pg_advisory_xact_lock and records it in META.SCHEMA_MIGRATION, which
--   the runner creates -- do not add that table here, it gates this file.
--   Forward-only: no down path, matching the device runner.
--
-- HOW TO CHANGE THE SCHEMA LATER
--   The runner keys the ledger on filename + content hash, so EDITING THIS FILE
--   re-applies it on the next deploy. That is the intended workflow and it is
--   only safe because every statement is idempotent:
--     * a new table   -> CREATE TABLE IF NOT EXISTS, appended
--     * a new column  -> ALTER TABLE ... ADD COLUMN IF NOT EXISTS, appended
--     * a new index   -> CREATE INDEX IF NOT EXISTS, appended
--     * a changed view-> edit the CREATE OR REPLACE VIEW in place
--   NEVER edit an existing CREATE TABLE's column list to change a live column --
--   IF NOT EXISTS makes that a silent no-op against a database that already has
--   the table, so the deploy goes green and the column keeps its old type. Add an
--   ALTER instead. Anything that is not idempotent goes in a NEW file, appended
--   to POSTGRES_FILES in tools/deploy-ddl.ts.
--
-- ============================================================================
-- TRANSLATION RULES, stated once
-- ============================================================================
--
--   Identifiers        Written UPPERCASE and never quoted, so Postgres folds
--                      them to lower case and `CURATED.SAMPLE_POINT` in a query
--                      resolves. The two DDL families stay diffable.
--                      NEVER quote an identifier in this file or in a query
--                      against it -- "SAMPLE_POINT" and SAMPLE_POINT are
--                      different tables in Postgres.
--   VARCHAR(n)         varchar(n). Faithful: both dialects error on overflow.
--   NUMBER(p,s)        numeric(p,s). The driver returns these as strings, which
--                      is what the SQL API does and what consumers parse.
--   TIMESTAMP_NTZ      timestamptz -- a DELIBERATE divergence, see below.
--   BOOLEAN            boolean. Normalised to 'true'/'false' by the adapter,
--                      never Postgres' own 't'/'f' text form.
--   VARIANT            jsonb.
--   ARRAY              jsonb, not text[] -- consumers JSON.parse these columns
--                      (`toSpec`, `findExistingImport`) and jsonb reproduces
--                      Snowflake's JSON-text rendering exactly.
--   GEOGRAPHY          OMITTED. There is no PostGIS. See section 0.
--   CURRENT_TIMESTAMP()  now()  (Postgres rejects the parens)
--   CURRENT_USER()       CURRENT_USER (same)
--
-- TIMESTAMP_NTZ -> timestamptz, and why not `timestamp`
--   `timestamp` is the literal counterpart of TIMESTAMP_NTZ, and it is the wrong
--   choice here. Every value this app writes is an ISO-8601 string with a Z, and
--   a zone-less column parses that by silently discarding the offset. For an
--   application whose entire purpose is capture provenance across time zones, an
--   ambiguous timestamp column is the one thing not to have. CAPTURED_TS_UTC_OFFSET
--   still carries the device's local offset separately, so nothing is lost.
--   Consequence: Snowflake's SQL API renders timestamps as epoch seconds and this
--   backend renders them as ISO-8601. `asIsoTimestamp()` in
--   src/shared/db/port.ts accepts either; anything that parses a timestamp read
--   back out of the database goes through it.
--
-- NO FOREIGN KEYS, deliberately
--   Snowflake does not enforce referential integrity and the sync contract is
--   built on that: a child record whose parent has not arrived must land and
--   become a defect, not be rejected. Contract 5 orders parents before children
--   *within* a batch, but a week of offline work can split them across batches.
--   Adding FKs here would convert "lands referentially sound even though the
--   warehouse does not enforce it" into a hard failure that loses a sample.
--   Indexes give the join performance; the integrity check is the defect rules.
-- ============================================================================


-- ============================================================================
-- 0. GEOSPATIAL IS DEFERRED, AND THE ABSENCE IS RECORDED IN THE DATA
--
-- There is no PostGIS. ST_WITHIN, ST_DISTANCE, ST_AZIMUTH, ST_CENTROID, ST_X/Y,
-- ST_ASGEOJSON and the ST_XMIN/XMAX/YMIN/YMAX bounds do not run on this backend,
-- so the GEOGRAPHY columns (SAMPLE_POINT.GEOG, SAMPLE_PLAN_POINT.PLANNED_GEOG,
-- BOUNDARY.GEOG) have no counterpart here and are not created. LAT/LON survive
-- on every one of them, so lifting the deferral needs no migration.
--
-- THE FAILURE THIS SECTION EXISTS TO PREVENT
--
-- Two defect rules are computations over geography: POINT_OUTSIDE_BOUNDARY (from
-- ST_WITHIN) and OFFSET_EXCEEDED_NO_REASON (from OFFSET_FROM_PLAN_M, i.e.
-- ST_DISTANCE). If neither runs and nothing says so, the pipeline completes, no
-- defect is raised, and every sample reads REVIEW_STATE = 'screened'. A tester
-- concludes defect detection works. An auditor in 2029 cannot tell an unchecked
-- sample from a checked-and-clean one. The offset rule already fails silently by
-- construction -- offset_from_plan_m === null is a `continue`, not an error.
--
-- That is worse than the feature being missing, so:
--
--   1. SAMPLE_POINT.GEO_DERIVATION_STATE, NOT NULL DEFAULT 'pending'. Every row
--      states which geographic derivation it actually received.
--   2. CURATED.DERIVATION_RUN records, per run per batch, which backend ran it,
--      whether that backend had geospatial, and which steps were skipped.
--   3. A CHECK constraint: REVIEW_STATE = 'screened' is REFUSED unless
--      GEO_DERIVATION_STATE is a derived value. The clean terminal state on this
--      backend is 'screened_partial'. The Postgres path CANNOT record a full
--      pass it did not perform -- it fails at the write, in a test, in the first
--      hour, instead of in an audit in three years.
--
-- BOUNDARY_ID: NULLABLE, NO SENTINEL. The open board question is settled here --
-- reasoning in the wave report, but the short form is that a BOUNDARY_UNKNOWN
-- sentinel can encode only one unknown, and there are two. "Checked; inside no
-- active boundary" is a finding worth acting on. "Never checked" is not a finding
-- at all. A sentinel makes them the same row and a NOT NULL column forces every
-- writer to know about it. NULL + GEO_DERIVATION_STATE distinguishes them, and
-- makes NULL-with-'derived_geodesic' a positive assertion rather than an absence.
--
-- Constants mirror GEO_DERIVATION_STATE / REVIEW_STATE in
-- src/shared/db/geo-assurance.ts. The CHECKs below and that file are two halves
-- of one decision; keep them in step.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS RAW;
CREATE SCHEMA IF NOT EXISTS REF;
CREATE SCHEMA IF NOT EXISTS CURATED;
CREATE SCHEMA IF NOT EXISTS META;


-- ============================================================================
-- 1. RAW -- verbatim payloads. Never edited, never overwritten.
-- ============================================================================

-- PAYLOAD_TEXT is the reproducibility anchor and it is new in this file.
--
-- RAW_PAYLOAD_HASH is SHA-256 of the request body as received, computed in
-- handleSyncBatch before anything is parsed -- that is already true on both
-- backends and this file does not change it. What changes is that the bytes the
-- hash addresses are now recoverable from the database as well as from Netlify
-- Blobs: PAYLOAD_TEXT holds them verbatim, and PAYLOAD is the queryable
-- projection derived from them.
--
-- This matters because jsonb normalises key order and drops duplicate keys --
-- and so does Snowflake's VARIANT, so the Snowflake row was never byte-faithful
-- either. Re-serialising PAYLOAD would produce bytes that do not hash to
-- RAW_PAYLOAD_HASH on either backend. PAYLOAD_TEXT is what makes
-- sha256(PAYLOAD_TEXT) = RAW_PAYLOAD_HASH a checkable statement rather than an
-- article of faith, and it is what tests/acceptance/05-rebuild-from-raw.ts
-- should read on this backend.
--
-- INVARIANT: PAYLOAD_TEXT and PAYLOAD are written from the SAME bind, in the
-- same statement, and neither is ever updated. The octet_length CHECK catches a
-- truncated write, which is the failure that would otherwise look like a hash
-- mismatch months later.
CREATE TABLE IF NOT EXISTS RAW.SYNC_PAYLOAD (
    RAW_PAYLOAD_HASH    varchar(64)  NOT NULL PRIMARY KEY,   -- SHA-256 of the body
    DEVICE_ID           varchar(64),
    SYNC_BATCH_ID       varchar(64),
    PAYLOAD_TEXT        text         NOT NULL,               -- VERBATIM. The hash anchor.
    PAYLOAD             jsonb        NOT NULL,               -- queryable projection of the above
    PAYLOAD_BYTES       numeric(12,0),
    SCHEMA_VERSION      varchar(16),
    APP_VERSION         varchar(32),
    RECEIVED_TS         timestamptz  DEFAULT now(),
    LOAD_TS             timestamptz  DEFAULT now(),
    LOADED_BY           varchar(128) DEFAULT CURRENT_USER,
    CONSTRAINT SYNC_PAYLOAD_BYTES_MATCH CHECK (
        PAYLOAD_BYTES IS NULL OR octet_length(PAYLOAD_TEXT) = PAYLOAD_BYTES
    )
);
CREATE INDEX IF NOT EXISTS IX_SYNC_PAYLOAD_BATCH ON RAW.SYNC_PAYLOAD(SYNC_BATCH_ID);
CREATE INDEX IF NOT EXISTS IX_SYNC_PAYLOAD_RECEIVED ON RAW.SYNC_PAYLOAD(RECEIVED_TS);

CREATE TABLE IF NOT EXISTS RAW.MEDIA_UPLOAD_LOG (
    CONTENT_HASH        varchar(64)  NOT NULL,
    MEDIA_ID            varchar(64),
    DEVICE_ID           varchar(64),
    OBJECT_KEY          varchar(512),
    BYTES               numeric(12,0),
    UPLOAD_STARTED_TS   timestamptz,
    UPLOAD_COMPLETED_TS timestamptz,
    UPLOAD_STATE        varchar(16),
    LOAD_TS             timestamptz  DEFAULT now(),
    LOADED_BY           varchar(128) DEFAULT CURRENT_USER
);
CREATE INDEX IF NOT EXISTS IX_MEDIA_UPLOAD_LOG_HASH ON RAW.MEDIA_UPLOAD_LOG(CONTENT_HASH);

-- The uploaded spreadsheet, verbatim, content-hashed. Same discipline.
-- RAW_TEXT is the artefact for a clipboard_paste; for a file upload the bytes
-- live in Netlify Blobs under BLOB_KEY and CONTENT_HASH addresses them.
CREATE TABLE IF NOT EXISTS RAW.PLAN_IMPORT_FILE (
    CONTENT_HASH        varchar(64)  NOT NULL PRIMARY KEY,   -- SHA-256
    ORIGINAL_FILENAME   varchar(512),
    MIME_TYPE           varchar(128),
    BYTES               numeric(12,0),
    SOURCE_KIND         varchar(24),   -- file_upload | clipboard_paste
    BLOB_KEY            varchar(512),
    RAW_TEXT            text,          -- populated for clipboard_paste
    UPLOADED_BY         varchar(128),
    UPLOADED_TS         timestamptz  DEFAULT now(),
    LOAD_TS             timestamptz  DEFAULT now(),
    LOADED_BY           varchar(128) DEFAULT CURRENT_USER
);


-- ============================================================================
-- 2. REF -- reference data. The capture screen cannot render without it, which
--    is why the seeds in section 8 are part of the deploy and not an afterthought.
-- ============================================================================

CREATE TABLE IF NOT EXISTS REF.PROJECT_SAMPLING_SPEC (
    SPEC_ID                  varchar(64)  NOT NULL PRIMARY KEY,
    PROJECT_ID               varchar(64)  NOT NULL,
    PROTOCOL_VERSION         varchar(16)  NOT NULL,      -- e.g. 'BCARBON_V3.0'
    PERIOD_CODE              varchar(8)   NOT NULL,      -- S25 | F25 | S26 ...
    -- depth, per BCarbon v3.0: same interval at baseline and true-up
    DEPTH_TOP_CM             numeric(5,1) NOT NULL,
    DEPTH_BOTTOM_CM          numeric(5,1) NOT NULL,
    DEPTH_INCREMENTS_JSON    jsonb,                      -- [[0,15],[15,30]]
    OVERDRILL_CM             numeric(4,1) DEFAULT 5,
    -- compositing, per BCarbon v3.0: 5-10 cores within a <=2 m radius
    CORES_PER_COMPOSITE_MIN  numeric(3,0) DEFAULT 5,
    CORES_PER_COMPOSITE_MAX  numeric(3,0) DEFAULT 10,
    COMPOSITE_RADIUS_M       numeric(4,1) DEFAULT 2,
    BD_CORE_REQUIRED         boolean      DEFAULT true,
    BAG_SCHEME               varchar(32)  DEFAULT 'ONE_BAG_PER_POINT',
    -- capture gates
    REQUIRED_MEDIA_ROLES     jsonb,       -- ['label_photo','core_photo','site_photo']
    GPS_ACCURACY_REQUIRED_M  numeric(5,1) DEFAULT 10,
    MIN_GPS_FIX_COUNT        numeric(3,0) DEFAULT 3,
    MAX_PLAN_OFFSET_M_WARN   numeric(6,1) DEFAULT 15,
    MAX_PLAN_OFFSET_M_BLOCK  numeric(6,1) DEFAULT 30,
    DEFAULT_LAB_ID           varchar(32),
    EFFECTIVE_START          date         NOT NULL,
    EFFECTIVE_END            date,
    LOAD_TS                  timestamptz  DEFAULT now(),
    LOADED_BY                varchar(128) DEFAULT CURRENT_USER,
    LAST_UPDATED_TS          timestamptz  DEFAULT now(),
    LAST_UPDATED_BY          varchar(128) DEFAULT CURRENT_USER,
    ROW_HASH                 varchar(64)
);

CREATE TABLE IF NOT EXISTS REF.CONDITION_CODE (
    CONDITION_CODE      varchar(48)  NOT NULL,
    CODE_SET_VERSION    varchar(16)  NOT NULL,
    CONDITION_GROUP     varchar(48),          -- moisture | residue | crop | access | soil
    DISPLAY_LABEL       varchar(128),
    VALUE_TYPE          varchar(16),          -- none | band | number | text
    VALUE_OPTIONS       jsonb,
    SORT_ORDER          numeric(4,0),
    IS_ACTIVE           boolean      DEFAULT true,
    LOAD_TS             timestamptz  DEFAULT now(),
    LOADED_BY           varchar(128) DEFAULT CURRENT_USER,
    PRIMARY KEY (CONDITION_CODE, CODE_SET_VERSION)
);

CREATE TABLE IF NOT EXISTS REF.DEVIATION_REASON (
    DEVIATION_REASON_CODE varchar(48) NOT NULL PRIMARY KEY,
    DISPLAY_LABEL         varchar(128),
    REQUIRES_NOTE         boolean     DEFAULT false,
    REQUIRES_PHOTO        boolean     DEFAULT false,
    IS_SKIP_REASON        boolean     DEFAULT false,  -- true = point produced no sample
    IS_ACTIVE             boolean     DEFAULT true,
    LOAD_TS               timestamptz DEFAULT now(),
    LOADED_BY             varchar(128) DEFAULT CURRENT_USER
);

CREATE TABLE IF NOT EXISTS REF.DEFECT_CODE (
    DEFECT_CODE         varchar(48) NOT NULL PRIMARY KEY,
    DISPLAY_LABEL       varchar(160),
    DEFAULT_SEVERITY    varchar(16),   -- blocking | review | advisory
    RAISED_BY           varchar(16),   -- device | server_rule | analyst
    RULE_DESCRIPTION    varchar(512),
    IS_ACTIVE           boolean     DEFAULT true,
    LOAD_TS             timestamptz DEFAULT now(),
    LOADED_BY           varchar(128) DEFAULT CURRENT_USER
);

-- Shipped EMPTY in the v02 Snowflake addendum, which meant
-- COALESCE(..., FALSE) hid every defect from the field. Correct as a default,
-- wrong as a permanent state -- so this file seeds it in section 8, and the
-- verification query in section 9 fails if any code lacks a decision.
CREATE TABLE IF NOT EXISTS REF.DEFECT_FIELD_VISIBILITY (
    DEFECT_CODE      varchar(48) NOT NULL PRIMARY KEY,
    VISIBLE_TO_FIELD boolean,
    FIELD_GUIDANCE   varchar(512),   -- plain language, shown on the phone
    LOAD_TS          timestamptz DEFAULT now(),
    LOADED_BY        varchar(128) DEFAULT CURRENT_USER
);

CREATE TABLE IF NOT EXISTS REF.LAB (
    LAB_ID              varchar(32) NOT NULL PRIMARY KEY,
    LAB_NAME            varchar(128),
    BARCODE_SYMBOLOGY   varchar(48),   -- NULL by design until Agidata confirms
    BARCODE_PATTERN     varchar(256),  -- regex, advisory only
    BARCODE_REUSED      boolean,       -- drives the lab-join date window
    IS_ACTIVE           boolean     DEFAULT true,
    LOAD_TS             timestamptz DEFAULT now(),
    LOADED_BY           varchar(128) DEFAULT CURRENT_USER
);


-- ============================================================================
-- 3. CURATED -- the boundary cache
--
-- On Snowflake, CURATED.BOUNDARY / PROPERTY / LAB_RESULT are pass-through views
-- onto VCH_GEO (bootstrap section 7). There is no VCH_GEO to pass through to
-- from a Netlify database, so the boundary projection the in-scope code needs
-- has to exist locally.
--
-- This table is that, and it is a CACHE, not a source of record. It is also the
-- one place the unconfirmed entity-model naming lands on this backend -- the
-- same discipline as snowflake_v03_entity_compat.sql, which collapsed three
-- scattered references into V_BOUNDARY_ENTITY rather than guessing a name in
-- three places. Whatever VCH_GEO actually calls BOUNDARY / PROPERTY (Phase 1
-- entity model vs legacy FACT_BORDER) is a question for the loader that fills
-- this table, and for nothing else. THAT LOADER IS NOT WRITTEN and is not in
-- this pass -- see the wave report.
--
-- No GEOGRAPHY column. GEOJSON carries the polygon as jsonb, and the bbox and
-- centroid are stored PRECOMPUTED so that ST_CENTROID / ST_X / ST_Y /
-- ST_XMIN..YMAX have no caller. /ingest/validate's point-in-polygon is already
-- pure TypeScript over GeoJSON (src/shared/geo/point-in-polygon.ts), so ingest
-- validation is UNAFFECTED by the geospatial deferral -- only the derivation
-- pipeline's server-of-record boundary and offset are.
-- ============================================================================

CREATE TABLE IF NOT EXISTS CURATED.BOUNDARY_CACHE (
    BOUNDARY_ID       varchar(64)  NOT NULL PRIMARY KEY,
    PROPERTY_ID       varchar(64),
    PROPERTY_NAME     varchar(256),
    GEOM_ACRES        numeric(12,3),
    TRS_CANONICAL     varchar(32),
    STATUS            varchar(24),          -- 'active' is what the pipeline filters on
    GEOJSON           jsonb,                -- Polygon | MultiPolygon, WGS84
    -- Precomputed so no ST_* is needed to read them back.
    CENTROID_LAT      numeric(11,8),
    CENTROID_LON      numeric(12,8),
    BBOX_WEST         numeric(12,8),
    BBOX_SOUTH        numeric(11,8),
    BBOX_EAST         numeric(12,8),
    BBOX_NORTH        numeric(11,8),
    -- Provenance of the cache row itself. 'fixture' is a legitimate value in
    -- UAT and must be distinguishable from real exported geometry.
    SOURCE_KIND       varchar(32),          -- vch_geo_export | fixture | manual
    SOURCE_SYNCED_TS  timestamptz,
    LOAD_TS           timestamptz  DEFAULT now(),
    LOADED_BY         varchar(128) DEFAULT CURRENT_USER,
    LAST_UPDATED_TS   timestamptz  DEFAULT now(),
    LAST_UPDATED_BY   varchar(128) DEFAULT CURRENT_USER
);
CREATE INDEX IF NOT EXISTS IX_BOUNDARY_CACHE_STATUS ON CURATED.BOUNDARY_CACHE(STATUS);


-- ============================================================================
-- 4. CURATED -- the plan
-- ============================================================================

CREATE TABLE IF NOT EXISTS CURATED.SAMPLE_PLAN (
    PLAN_ID             varchar(64) NOT NULL PRIMARY KEY,
    BOUNDARY_ID         varchar(64) NOT NULL,
    SPEC_ID             varchar(64) NOT NULL,
    PERIOD_CODE         varchar(8)  NOT NULL,
    PLAN_VERSION        numeric(4,0) DEFAULT 1,
    PARENT_PLAN_ID      varchar(64),
    STATUS              varchar(16) DEFAULT 'draft',  -- draft|released|superseded
    POINT_COUNT         numeric(6,0),
    GENERATION_METHOD   varchar(64),
    RELEASED_TS         timestamptz,
    RELEASED_BY         varchar(128),
    IMPORT_ID           varchar(64),   -- v02: provenance; nullable, analyst-authored plans exist
    LOAD_TS             timestamptz  DEFAULT now(),
    LOADED_BY           varchar(128) DEFAULT CURRENT_USER,
    LAST_UPDATED_TS     timestamptz  DEFAULT now(),
    LAST_UPDATED_BY     varchar(128) DEFAULT CURRENT_USER,
    ROW_HASH            varchar(64)
);
-- loadPriorPlans() reads (PERIOD_CODE, BOUNDARY_ID, STATUS) and takes the
-- highest PLAN_VERSION. On Snowflake that is a QUALIFY; on Postgres it is a
-- window function in a subquery, and this index is what keeps it cheap.
CREATE INDEX IF NOT EXISTS IX_SAMPLE_PLAN_PERIOD_BOUNDARY
    ON CURATED.SAMPLE_PLAN(PERIOD_CODE, BOUNDARY_ID, PLAN_VERSION DESC);
CREATE INDEX IF NOT EXISTS IX_SAMPLE_PLAN_IMPORT ON CURATED.SAMPLE_PLAN(IMPORT_ID);

CREATE TABLE IF NOT EXISTS CURATED.SAMPLE_PLAN_POINT (
    PLAN_POINT_ID       varchar(64) NOT NULL PRIMARY KEY,
    PLAN_ID             varchar(64) NOT NULL,
    PLAN_POINT_LABEL    varchar(64),
    PLANNED_LAT         numeric(11,8) NOT NULL,
    PLANNED_LON         numeric(12,8) NOT NULL,
    -- PLANNED_GEOG omitted: no PostGIS. PLANNED_LAT/LON are the whole input to
    -- the deferred offset computation, so lifting the deferral is a code change.
    STRATA_LABEL        varchar(64),
    STRATIFICATION_METHOD varchar(32),
    ELEVATION_CLASS     varchar(8),
    PRIOR_SAMPLE_UID    varchar(64),   -- true-up link; navigated in v2
    SEQUENCE_NO         numeric(6,0),
    ACCESS_NOTE         varchar(512),
    IMPORT_ROW_ID       varchar(64),   -- v02: back to a row in a spreadsheet
    LOAD_TS             timestamptz  DEFAULT now(),
    LOADED_BY           varchar(128) DEFAULT CURRENT_USER,
    LAST_UPDATED_TS     timestamptz  DEFAULT now(),
    LAST_UPDATED_BY     varchar(128) DEFAULT CURRENT_USER,
    ROW_HASH            varchar(64)
);
CREATE INDEX IF NOT EXISTS IX_PLAN_POINT_PLAN ON CURATED.SAMPLE_PLAN_POINT(PLAN_ID);
-- STAMP_ROW_POINTS joins on IMPORT_ROW_ID; loadExistingLabels reads the label.
CREATE INDEX IF NOT EXISTS IX_PLAN_POINT_IMPORT_ROW ON CURATED.SAMPLE_PLAN_POINT(IMPORT_ROW_ID);


-- ============================================================================
-- 5. CURATED -- capture
-- ============================================================================

CREATE TABLE IF NOT EXISTS CURATED.DEVICE (
    DEVICE_ID           varchar(64) NOT NULL PRIMARY KEY,
    CREW_ORG_ID         varchar(64),
    DEVICE_LABEL        varchar(128),
    PLATFORM            varchar(32),
    OS_VERSION          varchar(48),
    APP_VERSION         varchar(32),
    IS_MANAGED          boolean     DEFAULT false,   -- false for BYOD contracted crew
    ENROLLED_TS         timestamptz,
    ENROLLED_BY         varchar(128),
    LAST_SEEN_TS        timestamptz,
    REVOKED_TS          timestamptz,
    REVOKED_REASON      varchar(256),
    -- v02: on a BYOD fleet this table IS the fleet inventory.
    DEVICE_MODEL        varchar(128),
    MANUFACTURER        varchar(128),
    USER_AGENT_RAW      varchar(512),
    LOAD_TS             timestamptz  DEFAULT now(),
    LOADED_BY           varchar(128) DEFAULT CURRENT_USER,
    LAST_UPDATED_TS     timestamptz  DEFAULT now(),
    LAST_UPDATED_BY     varchar(128) DEFAULT CURRENT_USER
);
CREATE INDEX IF NOT EXISTS IX_DEVICE_CREW ON CURATED.DEVICE(CREW_ORG_ID);

CREATE TABLE IF NOT EXISTS CURATED.SYNC_BATCH (
    SYNC_BATCH_ID       varchar(64) NOT NULL PRIMARY KEY,  -- client-generated
    DEVICE_ID           varchar(64) NOT NULL,
    CLIENT_SENT_TS      timestamptz,
    SERVER_RECEIVED_TS  timestamptz DEFAULT now(),
    RECORD_COUNT        numeric(8,0),
    ACCEPTED_COUNT      numeric(8,0),
    REJECTED_COUNT      numeric(8,0),
    RAW_PAYLOAD_HASH    varchar(64),
    APP_VERSION         varchar(32),
    SCHEMA_VERSION      varchar(16),
    LOAD_TS             timestamptz  DEFAULT now(),
    LOADED_BY           varchar(128) DEFAULT CURRENT_USER
);
CREATE INDEX IF NOT EXISTS IX_SYNC_BATCH_DEVICE ON CURATED.SYNC_BATCH(DEVICE_ID, SERVER_RECEIVED_TS);

CREATE TABLE IF NOT EXISTS CURATED.FIELD_VISIT (
    VISIT_ID                  varchar(64) NOT NULL PRIMARY KEY,  -- UUIDv7, device
    BOUNDARY_ID               varchar(64) NOT NULL,
    PLAN_ID                   varchar(64),
    SPEC_ID                   varchar(64),
    CREW_ORG_ID               varchar(64),
    SAMPLER_PERSON_ID         varchar(64),
    DEVICE_ID                 varchar(64),
    ACCESS_CONTACT_PERSON_ID  varchar(64),
    VISIT_DATE                date,
    STARTED_TS                timestamptz,
    ENDED_TS                  timestamptz,
    STATUS                    varchar(16) DEFAULT 'in_progress',
    ABANDON_REASON_CODE       varchar(48),
    VISIT_NOTE                varchar(1024),
    IS_PILOT                  boolean     DEFAULT false,  -- pilot data lands tagged,
                                          -- not in a schema needing migration
    APP_VERSION               varchar(32),
    SYNC_BATCH_ID             varchar(64),
    LOAD_TS                   timestamptz  DEFAULT now(),
    LOADED_BY                 varchar(128) DEFAULT CURRENT_USER,
    LAST_UPDATED_TS           timestamptz  DEFAULT now(),
    LAST_UPDATED_BY           varchar(128) DEFAULT CURRENT_USER,
    ROW_HASH                  varchar(64)
);
CREATE INDEX IF NOT EXISTS IX_FIELD_VISIT_CREW_DATE ON CURATED.FIELD_VISIT(CREW_ORG_ID, VISIT_DATE);
CREATE INDEX IF NOT EXISTS IX_FIELD_VISIT_BATCH ON CURATED.FIELD_VISIT(SYNC_BATCH_ID);

CREATE TABLE IF NOT EXISTS CURATED.SAMPLE_POINT (
    SAMPLE_UID              varchar(64)  NOT NULL PRIMARY KEY,  -- UUIDv7 at capture
    VISIT_ID                varchar(64)  NOT NULL,
    PLAN_POINT_ID           varchar(64),          -- NULL = field-added sample
    -- Server-side point-in-polygon. NULLABLE, no sentinel -- section 0.
    -- NULL means one of two different things and GEO_DERIVATION_STATE says which.
    BOUNDARY_ID             varchar(64),
    -- position, captured at the moment of sampling
    LAT                     numeric(11,8),
    LON                     numeric(12,8),
    -- GEOG omitted: no PostGIS.
    -- GEOG_VALID SURVIVES: on this backend it is "LAT/LON present and in range",
    -- which is pure arithmetic and needs no geospatial support. GEOM_INVALID
    -- therefore still fires here, unlike the two rules in section 0.
    GEOG_VALID              boolean,
    GPS_ACCURACY_M          numeric(7,2),
    ALTITUDE_M              numeric(8,2),
    ALTITUDE_ACCURACY_M     numeric(7,2),
    POSITION_PROVIDER       varchar(32),          -- gps | fused | network
    POSITION_SOURCE         varchar(24),          -- gps | manual_map_pin | plan_inherited
    FIX_COUNT               numeric(4,0),
    FIX_SPREAD_M            numeric(7,2),
    -- Deviation from plan. DEFERRED on this backend: ST_DISTANCE / ST_AZIMUTH.
    -- These stay NULL and GEO_DERIVATION_STATE = 'deferred_no_geospatial' is
    -- what stops OFFSET_EXCEEDED_NO_REASON's silent pass being read as a pass.
    OFFSET_FROM_PLAN_M      numeric(9,2),
    BEARING_FROM_PLAN_DEG   numeric(5,1),
    DEVIATION_REASON_CODE   varchar(48),
    -- time, device and server both preserved
    CAPTURED_TS_DEVICE      timestamptz,
    CAPTURED_TS_UTC_OFFSET  numeric(4,0),
    DEVICE_UPTIME_MS        numeric(15,0),        -- monotonic; exposes clock changes
    SYNCED_TS               timestamptz,
    SERVER_RECEIVED_TS      timestamptz,
    -- attribution
    SAMPLER_PERSON_ID       varchar(64),
    DEVICE_ID               varchar(64),
    SYNC_BATCH_ID           varchar(64),
    -- protocol, denormalized so the spec in force at capture survives supersession
    PERIOD_CODE             varchar(8),
    SPEC_ID                 varchar(64),
    PROTOCOL_VERSION        varchar(16),
    -- exception capture only; depth and core count default from the spec
    DEPTH_ACHIEVED_CM       numeric(5,1),
    REFUSAL_CODE            varchar(48),
    CORES_TAKEN             numeric(3,0),         -- NULL = per spec
    BD_CORE_TAKEN           boolean,
    -- derived. TRS is sourced from the containing boundary, so it is deferred
    -- with the boundary.
    TRS_CANONICAL           varchar(32),          -- server-derived, NEVER typed
    -- ---- geospatial assurance. NEW IN THIS FILE. Section 0. ----------------
    GEO_DERIVATION_STATE    varchar(32)  NOT NULL DEFAULT 'pending',
    GEO_DERIVED_TS          timestamptz,
    -- lifecycle
    REVIEW_STATE            varchar(24)  NOT NULL DEFAULT 'captured',
    SUPERSEDES_SAMPLE_UID   varchar(64),
    NOTE                    varchar(1024),
    LOAD_TS                 timestamptz  DEFAULT now(),
    LOADED_BY               varchar(128) DEFAULT CURRENT_USER,
    LAST_UPDATED_TS         timestamptz  DEFAULT now(),
    LAST_UPDATED_BY         varchar(128) DEFAULT CURRENT_USER,
    ROW_HASH                varchar(64),

    CONSTRAINT SAMPLE_POINT_GEO_STATE CHECK (GEO_DERIVATION_STATE IN (
        'pending',                  -- landed; the geography step has not run
        'derived_geodesic',         -- full ST_* on a geospatial backend
        'derived_planar',           -- app-side GeoJSON + haversine. RESERVED, unused
        'deferred_no_geospatial',   -- backend has no geospatial. NOT CHECKED
        'invalid_geometry'          -- checked; the coordinate is bad
    )),
    CONSTRAINT SAMPLE_POINT_REVIEW_STATE CHECK (REVIEW_STATE IN (
        'captured', 'screened', 'screened_partial', 'needs_review',
        'accepted', 'rejected'
    )),
    -- THE CONSTRAINT WITH TEETH.
    -- 'screened' means every server rule ran and found nothing. On a backend
    -- without geospatial that sentence is false, so the write is refused and the
    -- clean terminal state is 'screened_partial'. This is the difference between
    -- a Postgres deploy that reports honestly and one where every sample looks
    -- clean because two rules never ran. It fails at the write, in a test, on
    -- day one -- which is the entire design intent.
    -- Derivation step 8 must use cleanReviewStateFor() from
    -- src/shared/db/geo-assurance.ts rather than a literal 'screened'.
    CONSTRAINT SAMPLE_POINT_SCREENED_REQUIRES_GEO CHECK (
        REVIEW_STATE <> 'screened'
        OR GEO_DERIVATION_STATE IN ('derived_geodesic', 'derived_planar')
    )
);
CREATE INDEX IF NOT EXISTS IX_SAMPLE_POINT_BATCH ON CURATED.SAMPLE_POINT(SYNC_BATCH_ID);
CREATE INDEX IF NOT EXISTS IX_SAMPLE_POINT_VISIT ON CURATED.SAMPLE_POINT(VISIT_ID);
CREATE INDEX IF NOT EXISTS IX_SAMPLE_POINT_PLAN_POINT ON CURATED.SAMPLE_POINT(PLAN_POINT_ID);
CREATE INDEX IF NOT EXISTS IX_SAMPLE_POINT_BOUNDARY ON CURATED.SAMPLE_POINT(BOUNDARY_ID);
-- "How many samples were never boundary-checked" must be one cheap query.
CREATE INDEX IF NOT EXISTS IX_SAMPLE_POINT_GEO_STATE ON CURATED.SAMPLE_POINT(GEO_DERIVATION_STATE);

CREATE TABLE IF NOT EXISTS CURATED.SAMPLE_BAG (
    BAG_ID                  varchar(64) NOT NULL PRIMARY KEY,  -- UUIDv7, device
    SAMPLE_UID              varchar(64) NOT NULL,
    BAG_SEQ                 numeric(3,0) DEFAULT 1,            -- 1 in v1
    BAG_ROLE                varchar(24)  DEFAULT 'composite',
    DEPTH_TOP_CM            numeric(5,1),        -- defaults from spec
    DEPTH_BOTTOM_CM         numeric(5,1),
    LAB_ID                  varchar(32),
    BARCODE_RAW             varchar(256),        -- VERBATIM. Never normalised in place
    BARCODE_NORM            varchar(256),        -- derived column, rebuildable
    BARCODE_SYMBOLOGY       varchar(48),
    BARCODE_CAPTURE_METHOD  varchar(24),         -- scan|manual_entry|photo_recovered
    BARCODE_SCANNED_TS      timestamptz,
    BARCODE_DUPLICATE_FLAG  boolean      DEFAULT false,
    SHIPMENT_ID             varchar(64),         -- nullable; v2
    VOID_FLAG               boolean      DEFAULT false,
    VOID_REASON_CODE        varchar(48),
    SYNC_BATCH_ID           varchar(64),
    LOAD_TS                 timestamptz  DEFAULT now(),
    LOADED_BY               varchar(128) DEFAULT CURRENT_USER,
    LAST_UPDATED_TS         timestamptz  DEFAULT now(),
    LAST_UPDATED_BY         varchar(128) DEFAULT CURRENT_USER,
    ROW_HASH                varchar(64)
);
CREATE INDEX IF NOT EXISTS IX_SAMPLE_BAG_SAMPLE ON CURATED.SAMPLE_BAG(SAMPLE_UID);
CREATE INDEX IF NOT EXISTS IX_SAMPLE_BAG_BATCH ON CURATED.SAMPLE_BAG(SYNC_BATCH_ID);
-- NOT UNIQUE, emphatically. A duplicate (LAB_ID, BARCODE_RAW) is the thing
-- BARCODE_DUPLICATE detects; a unique constraint here would reject the second
-- bag instead of flagging it, and the sample would be lost rather than queued.
CREATE INDEX IF NOT EXISTS IX_SAMPLE_BAG_BARCODE ON CURATED.SAMPLE_BAG(LAB_ID, BARCODE_RAW);

CREATE TABLE IF NOT EXISTS CURATED.SAMPLE_CONDITION (
    CONDITION_ID        varchar(64) NOT NULL PRIMARY KEY,
    SAMPLE_UID          varchar(64) NOT NULL,
    CONDITION_CODE      varchar(48) NOT NULL,
    CONDITION_VALUE     varchar(128),
    CODE_SET_VERSION    varchar(16),
    SYNC_BATCH_ID       varchar(64),
    LOAD_TS             timestamptz  DEFAULT now(),
    LOADED_BY           varchar(128) DEFAULT CURRENT_USER
);
CREATE INDEX IF NOT EXISTS IX_SAMPLE_CONDITION_SAMPLE ON CURATED.SAMPLE_CONDITION(SAMPLE_UID);

-- Media is deliberately NOT 1:1 with samples. At least one of the three parent
-- keys must be non-null; a blocked-approach photo belongs to the visit, not to
-- any hole. (SAMPLE_UID, MEDIA_ROLE) is intentionally not unique.
CREATE TABLE IF NOT EXISTS CURATED.MEDIA (
    MEDIA_ID            varchar(64) NOT NULL PRIMARY KEY,  -- UUIDv7, device
    CONTENT_HASH        varchar(64) NOT NULL,              -- SHA-256, addresses store
    SAMPLE_UID          varchar(64),
    BAG_ID              varchar(64),
    VISIT_ID            varchar(64),
    MEDIA_ROLE          varchar(32),
    IS_REQUIRED_ROLE    boolean     DEFAULT false,
    CAPTURE_ORDER       numeric(4,0),
    CAPTURE_TS_DEVICE   timestamptz,
    EXIF_LAT            numeric(11,8),   -- verbatim; independent corroboration
    EXIF_LON            numeric(12,8),
    EXIF_TS             timestamptz,
    EXIF_RAW            jsonb,
    EXIF_GPS_PRESENT    boolean,         -- v02; avoids unpacking EXIF_RAW
    BYTES               numeric(12,0),
    WIDTH_PX            numeric(6,0),
    HEIGHT_PX           numeric(6,0),
    MIME_TYPE           varchar(64),
    OBJECT_KEY          varchar(512),
    UPLOAD_STATE        varchar(16) DEFAULT 'pending',
    UPLOADED_TS         timestamptz,
    -- v02: the single most important audit distinction in this table. A photo
    -- picked from the camera roll is not evidence of having been at the hole.
    CAPTURE_SOURCE      varchar(24) DEFAULT 'unknown',  -- in_app_camera |
                                                        -- device_gallery | unknown
    DEVICE_ID           varchar(64),     -- provenance stands alone
    SYNC_BATCH_ID       varchar(64),
    LOAD_TS             timestamptz  DEFAULT now(),
    LOADED_BY           varchar(128) DEFAULT CURRENT_USER,
    LAST_UPDATED_TS     timestamptz  DEFAULT now(),
    LAST_UPDATED_BY     varchar(128) DEFAULT CURRENT_USER,
    ROW_HASH            varchar(64),
    CONSTRAINT MEDIA_HAS_PARENT CHECK (
        SAMPLE_UID IS NOT NULL OR BAG_ID IS NOT NULL OR VISIT_ID IS NOT NULL
    )
);
CREATE INDEX IF NOT EXISTS IX_MEDIA_SAMPLE ON CURATED.MEDIA(SAMPLE_UID);
CREATE INDEX IF NOT EXISTS IX_MEDIA_BATCH ON CURATED.MEDIA(SYNC_BATCH_ID);
CREATE INDEX IF NOT EXISTS IX_MEDIA_CONTENT_HASH ON CURATED.MEDIA(CONTENT_HASH);

CREATE TABLE IF NOT EXISTS CURATED.SAMPLE_DEFECT (
    DEFECT_ID           varchar(64) NOT NULL PRIMARY KEY,  -- MD5(subject|code),
                                        -- deterministic so a re-run updates
                                        -- rather than raising a second row
    SAMPLE_UID          varchar(64),
    BAG_ID              varchar(64),
    VISIT_ID            varchar(64),
    PLAN_POINT_ID       varchar(64),   -- for PLAN_POINT_UNSAMPLED
    DEFECT_CODE         varchar(48) NOT NULL,
    SEVERITY            varchar(16),
    DETECTED_BY         varchar(16),   -- device | server_rule | analyst
    DETECTED_TS         timestamptz DEFAULT now(),
    DETAIL              varchar(1024),
    RESOLUTION_STATE    varchar(24) DEFAULT 'open',
    RESOLVED_BY         varchar(128),
    RESOLVED_TS         timestamptz,
    RESOLUTION_NOTE     varchar(1024),
    -- v02 down-sync. Only defects a crew can act on are pushed to the field.
    VISIBLE_TO_FIELD    boolean     DEFAULT false,
    FIELD_ACKED_TS      timestamptz,   -- seen != resolved. Only an analyst resolves.
    LOAD_TS             timestamptz  DEFAULT now(),
    LOADED_BY           varchar(128) DEFAULT CURRENT_USER,
    LAST_UPDATED_TS     timestamptz  DEFAULT now(),
    LAST_UPDATED_BY     varchar(128) DEFAULT CURRENT_USER
);
CREATE INDEX IF NOT EXISTS IX_SAMPLE_DEFECT_SAMPLE ON CURATED.SAMPLE_DEFECT(SAMPLE_UID);
CREATE INDEX IF NOT EXISTS IX_SAMPLE_DEFECT_OPEN
    ON CURATED.SAMPLE_DEFECT(RESOLUTION_STATE, DETECTED_TS);
CREATE INDEX IF NOT EXISTS IX_SAMPLE_DEFECT_PLAN_POINT ON CURATED.SAMPLE_DEFECT(PLAN_POINT_ID);


-- ============================================================================
-- 6. CURATED -- what the derivation pipeline actually did
--
-- NEW IN THIS FILE, and the batch-level half of section 0. Append-only log: one
-- row per pipeline run per batch. It answers "was this batch's geography ever
-- checked, and by what" even after the sample rows are re-derived by a later,
-- geospatial-capable run -- which the per-row GEO_DERIVATION_STATE alone cannot,
-- because a re-derivation overwrites it.
--
-- STEPS_SKIPPED is the column that matters. An empty STEPS_SKIPPED on a run with
-- GEO_CAPABILITY = 'none' is a bug in the pipeline, not a clean run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS CURATED.DERIVATION_RUN (
    RUN_ID                  varchar(64) NOT NULL PRIMARY KEY,  -- UUIDv7 per run
    SYNC_BATCH_ID           varchar(64) NOT NULL,
    STARTED_TS              timestamptz DEFAULT now(),
    ENDED_TS                timestamptz,
    OUTCOME                 varchar(16),   -- ok | failed | partial
    BACKEND                 varchar(16),   -- snowflake | postgres
    GEO_CAPABILITY          varchar(8),    -- full | none
    STEPS_COMPLETED         jsonb,         -- ['geography','point_in_polygon',...]
    STEPS_SKIPPED           jsonb,         -- ['point_in_polygon','offset_from_plan','trs']
    DEFECTS_RAISED          numeric(8,0),
    SAMPLES_SCREENED        numeric(8,0),
    SAMPLES_NEEDING_REVIEW  numeric(8,0),
    PIPELINE_VERSION        varchar(32),
    DETAIL_JSON             jsonb,
    LOAD_TS                 timestamptz  DEFAULT now(),
    LOADED_BY               varchar(128) DEFAULT CURRENT_USER,
    CONSTRAINT DERIVATION_RUN_GEO_CAPABILITY CHECK (
        GEO_CAPABILITY IS NULL OR GEO_CAPABILITY IN ('full', 'none')
    )
);
CREATE INDEX IF NOT EXISTS IX_DERIVATION_RUN_BATCH
    ON CURATED.DERIVATION_RUN(SYNC_BATCH_ID, STARTED_TS DESC);


-- ============================================================================
-- 7. CURATED -- the plan-point ingest tool
-- ============================================================================

CREATE TABLE IF NOT EXISTS CURATED.PLAN_IMPORT (
    IMPORT_ID           varchar(64)  NOT NULL PRIMARY KEY,
    CONTENT_HASH        varchar(64)  NOT NULL,
    IMPORTED_BY         varchar(128) NOT NULL,
    IMPORTED_TS         timestamptz  DEFAULT now(),
    SOURCE_KIND         varchar(24),
    ORIGINAL_FILENAME   varchar(512),
    SHEET_NAME          varchar(128),
    MAPPING_JSON        jsonb,         -- resolved column mapping; makes the
                                       -- import reproducible from the raw file
    PERIOD_CODE         varchar(8),
    PROJECT_ID          varchar(64),
    ROW_COUNT           numeric(8,0),
    ROWS_COMMITTED      numeric(8,0),
    ROWS_FLAGGED        numeric(8,0),
    ROWS_BLOCKED        numeric(8,0),
    PLAN_IDS            jsonb,         -- plans created or revised
    STATUS              varchar(16)  DEFAULT 'staged',  -- staged|committed|retired
    RETIRED_BY          varchar(128),
    RETIRED_TS          timestamptz,
    RETIRE_REASON       varchar(512),
    LOAD_TS             timestamptz  DEFAULT now(),
    LOADED_BY           varchar(128) DEFAULT CURRENT_USER,
    LAST_UPDATED_TS     timestamptz  DEFAULT now(),
    LAST_UPDATED_BY     varchar(128) DEFAULT CURRENT_USER,
    ROW_HASH            varchar(64)
);
CREATE INDEX IF NOT EXISTS IX_PLAN_IMPORT_CONTENT_HASH ON CURATED.PLAN_IMPORT(CONTENT_HASH);

-- One row per INPUT row, INCLUDING blocked ones. An import that silently
-- dropped five rows is an import nobody can audit.
CREATE TABLE IF NOT EXISTS CURATED.PLAN_IMPORT_ROW (
    IMPORT_ROW_ID           varchar(64) NOT NULL PRIMARY KEY,
    IMPORT_ID               varchar(64) NOT NULL,
    SOURCE_ROW_NO           numeric(8,0),
    -- RAW_VALUES_TEXT is new in this file, and it is here for the same reason
    -- RAW.SYNC_PAYLOAD.PAYLOAD_TEXT is: jsonb (like VARIANT) is an unordered
    -- object, so RAW_VALUES_JSON alone loses spreadsheet COLUMN ORDER. The
    -- commit path already has the verbatim string in hand
    -- (`JSON.stringify(row.raw_values)`), so preserving it costs nothing and
    -- keeps the row's reproducibility anchor faithful.
    RAW_VALUES_TEXT         text,
    RAW_VALUES_JSON         jsonb,          -- queryable projection, pre-mapping
    -- mapped values
    PLAN_POINT_LABEL        varchar(64),
    LAT_RAW                 varchar(64),    -- exactly as supplied
    LON_RAW                 varchar(64),
    LAT                     numeric(11,8),
    LON                     numeric(12,8),
    COORD_FORMAT_DETECTED   varchar(16),    -- decimal | dms | unknown
    COORD_FIX_APPLIED       varchar(32),    -- e.g. swap_lat_lon
    BOUNDARY_ID_STATED      varchar(64),
    BOUNDARY_ID_RESOLVED    varchar(64),    -- point-in-polygon, app-side here
    FIELD_NAME              varchar(256),
    STRATA_LABEL            varchar(64),
    ELEVATION_CLASS         varchar(8),
    SEQUENCE_NO             numeric(6,0),
    ACCESS_NOTE             varchar(512),
    PRIOR_SAMPLE_UID        varchar(64),
    EXTRA_JSON              jsonb,          -- unmapped columns, PRESERVED
    -- CRM candidates. TEXT ONLY. An upload never creates a CRM record (D16).
    OPERATION_TEXT          varchar(256),
    OPERATION_MATCH_ID      varchar(64),
    OPERATION_MATCH_SCORE   numeric(5,4),
    OPERATION_MATCH_STATUS  varchar(24),    -- matched|suggested|unmatched|
                                            -- resolved_by_analyst
    CONTACT_NAME_TEXT       varchar(256),
    CONTACT_PHONE_TEXT      varchar(64),
    CONTACT_EMAIL_TEXT      varchar(256),
    CONTACT_MATCH_ID        varchar(64),
    CONTACT_MATCH_SCORE     numeric(5,4),
    CONTACT_MATCH_STATUS    varchar(24),
    -- outcome
    ROW_STATUS              varchar(16),    -- ready|flagged|blocked|committed|
                                            -- superseded
    VALIDATION_CODES        jsonb,
    PLAN_POINT_ID           varchar(64),    -- set on commit
    LOAD_TS                 timestamptz  DEFAULT now(),
    LOADED_BY               varchar(128) DEFAULT CURRENT_USER,
    LAST_UPDATED_TS         timestamptz  DEFAULT now(),
    LAST_UPDATED_BY         varchar(128) DEFAULT CURRENT_USER,
    ROW_HASH                varchar(64)
);
CREATE INDEX IF NOT EXISTS IX_IMPORT_ROW_IMPORT ON CURATED.PLAN_IMPORT_ROW(IMPORT_ID);

-- Per-user memory. Makes upload #2 zero-click and gates the tutorial.
-- Server-side and NOT a cookie: a new laptop must not re-teach an experienced
-- user. Unused by code today; C13 (the ingest tutorial branch) is its first
-- consumer, and it is here because it is an ingest table and ingest is in scope.
-- (PERSON_REF, SURFACE) is the natural key an upsert should use, so it is UNIQUE
-- even though PROFILE_ID is the primary key.
CREATE TABLE IF NOT EXISTS CURATED.IMPORT_PROFILE (
    PROFILE_ID              varchar(64)  NOT NULL PRIMARY KEY,
    PERSON_REF              varchar(128) NOT NULL,  -- token identity (MVP),
                                                    -- person_id after IdP
    SURFACE                 varchar(24),            -- ingest | sampler
    MAPPING_JSON            jsonb,                  -- last accepted mapping
    MAPPING_UPDATED_TS      timestamptz,
    TUTORIAL_COMPLETED_TS   timestamptz,
    TUTORIAL_SKIPPED_FLAG   boolean      DEFAULT false,
    DEFAULT_PERIOD_CODE     varchar(8),
    DEFAULT_PROJECT_ID      varchar(64),
    IMPORT_COUNT            numeric(8,0) DEFAULT 0,
    LOAD_TS                 timestamptz  DEFAULT now(),
    LOADED_BY               varchar(128) DEFAULT CURRENT_USER,
    LAST_UPDATED_TS         timestamptz  DEFAULT now(),
    LAST_UPDATED_BY         varchar(128) DEFAULT CURRENT_USER
);
CREATE UNIQUE INDEX IF NOT EXISTS UX_IMPORT_PROFILE_PERSON_SURFACE
    ON CURATED.IMPORT_PROFILE(PERSON_REF, SURFACE);

-- Actor log for the surfaces that are NOT the sampling app. In scope because
-- /ingest/commit and /ingest/retire write it as part of the commit rather than
-- as a note about it.
CREATE TABLE IF NOT EXISTS CURATED.AUDIT_EVENT (
    EVENT_ID        varchar(64) NOT NULL PRIMARY KEY,
    EVENT_TS        timestamptz DEFAULT now(),
    ACTOR_REF       varchar(128),
    ACTOR_KIND      varchar(24),   -- token | idp_user | service
    SURFACE         varchar(24),   -- ingest | analyst | admin | sync
    ACTION          varchar(48),
    ENTITY_TYPE     varchar(48),
    ENTITY_ID       varchar(64),
    DETAIL_JSON     jsonb,
    IP_HASH         varchar(64),   -- hashed, not stored raw
    USER_AGENT_RAW  varchar(512),
    LOAD_TS         timestamptz  DEFAULT now(),
    LOADED_BY       varchar(128) DEFAULT CURRENT_USER
);
CREATE INDEX IF NOT EXISTS IX_AUDIT_EVENT_ENTITY ON CURATED.AUDIT_EVENT(ENTITY_TYPE, ENTITY_ID);
CREATE INDEX IF NOT EXISTS IX_AUDIT_EVENT_TS ON CURATED.AUDIT_EVENT(EVENT_TS);


-- ============================================================================
-- 8. VIEWS
--
-- Present: the entity-name isolation view, geospatial assurance, plan
-- completion, the field defect feed, and import preview/provenance.
-- Absent, deliberately -- see the wave report:
--   V_SAMPLE_REVIEW_QUEUE   analyst queue, out of scope this pass
--   V_BAG_LAB_MATCH,
--   V_LAB_RESULT_ENTITY     lab join; no LAB_RESULT exists on this backend
--   V_SAMPLE_PLAN_OFFSET    is ST_DISTANCE; deferred with the geospatial
--   SP_RESOLVE_SAMPLE_BOUNDARY  is ST_WITHIN; same
-- ============================================================================

-- The one place the entity-model naming question lands on this backend.
-- Column list deliberately matches snowflake_v03_entity_compat.sql's
-- V_BOUNDARY_ENTITY, MINUS GEOG and PLUS the precomputed geometry summaries --
-- so a consumer that used ST_ASGEOJSON(GEOG) reads GEOJSON, and one that used
-- ST_Y(ST_CENTROID(GEOG)) reads CENTROID_LAT.
CREATE OR REPLACE VIEW CURATED.V_BOUNDARY_ENTITY AS
SELECT b.BOUNDARY_ID,
       b.PROPERTY_ID,
       b.PROPERTY_NAME,
       b.GEOM_ACRES,
       b.TRS_CANONICAL,
       b.STATUS,
       b.GEOJSON,
       b.CENTROID_LAT,
       b.CENTROID_LON,
       b.BBOX_WEST,
       b.BBOX_SOUTH,
       b.BBOX_EAST,
       b.BBOX_NORTH
  FROM CURATED.BOUNDARY_CACHE b;

-- THE AUDITOR'S QUERY. One column that never says "clean" about a sample whose
-- geographic checks did not run.
--
-- ASSURANCE_VERDICT is the point of the whole of section 0:
--   clean_verified       every server rule ran, nothing found
--   clean_geo_unverified passed every RUNNABLE rule; geography was NOT checked
--   needs_review         a rule found something
--   awaiting_derivation  the pipeline has not reached this row yet
--   bad_coordinate       lat/lon did not parse
--   analyst_accepted / analyst_rejected  a human decided
CREATE OR REPLACE VIEW CURATED.V_SAMPLE_GEO_ASSURANCE AS
SELECT sp.SAMPLE_UID,
       sp.VISIT_ID,
       sp.SYNC_BATCH_ID,
       sp.PLAN_POINT_ID,
       sp.LAT,
       sp.LON,
       sp.BOUNDARY_ID,
       sp.OFFSET_FROM_PLAN_M,
       sp.TRS_CANONICAL,
       sp.GEOG_VALID,
       sp.GEO_DERIVATION_STATE,
       sp.GEO_DERIVED_TS,
       sp.REVIEW_STATE,
       (sp.GEO_DERIVATION_STATE IN ('derived_geodesic', 'derived_planar')) AS GEO_CHECKED,
       -- "checked, and inside no active boundary" is a finding. "never checked"
       -- is not. A nullable BOUNDARY_ID alone cannot tell them apart; this can.
       (sp.BOUNDARY_ID IS NULL
        AND sp.GEO_DERIVATION_STATE IN ('derived_geodesic', 'derived_planar'))
                                                            AS OUTSIDE_ALL_BOUNDARIES,
       (sp.BOUNDARY_ID IS NULL
        AND sp.GEO_DERIVATION_STATE = 'deferred_no_geospatial') AS BOUNDARY_UNKNOWN,
       CASE
         WHEN sp.REVIEW_STATE = 'accepted'          THEN 'analyst_accepted'
         WHEN sp.REVIEW_STATE = 'rejected'          THEN 'analyst_rejected'
         WHEN sp.REVIEW_STATE = 'needs_review'      THEN 'needs_review'
         WHEN sp.GEO_DERIVATION_STATE = 'invalid_geometry' THEN 'bad_coordinate'
         WHEN sp.REVIEW_STATE = 'screened'          THEN 'clean_verified'
         WHEN sp.REVIEW_STATE = 'screened_partial'  THEN 'clean_geo_unverified'
         ELSE 'awaiting_derivation'
       END AS ASSURANCE_VERDICT
  FROM CURATED.SAMPLE_POINT sp;

-- Plan completion -- what has NOT been sampled is as important as what has.
-- IFF -> CASE; everything else ports as written.
CREATE OR REPLACE VIEW CURATED.V_PLAN_COMPLETION AS
SELECT p.PLAN_ID,
       p.BOUNDARY_ID,
       p.PERIOD_CODE,
       p.POINT_COUNT                                    AS PLANNED_POINTS,
       COUNT(DISTINCT sp.PLAN_POINT_ID)                 AS PLAN_POINTS_SAMPLED,
       COUNT(sp.SAMPLE_UID)                             AS SAMPLES_CAPTURED,
       SUM(CASE WHEN sp.PLAN_POINT_ID IS NULL THEN 1 ELSE 0 END) AS FIELD_ADDED_SAMPLES,
       p.POINT_COUNT - COUNT(DISTINCT sp.PLAN_POINT_ID) AS PLAN_POINTS_OUTSTANDING
  FROM CURATED.SAMPLE_PLAN p
  LEFT JOIN CURATED.SAMPLE_PLAN_POINT pp ON pp.PLAN_ID = p.PLAN_ID
  LEFT JOIN CURATED.SAMPLE_POINT sp      ON sp.PLAN_POINT_ID = pp.PLAN_POINT_ID
 WHERE p.STATUS = 'released'
 GROUP BY p.PLAN_ID, p.BOUNDARY_ID, p.PERIOD_CODE, p.POINT_COUNT;

-- What the field sees next morning. Only actionable codes, only recent work.
-- DATEADD(DAY, -5, CURRENT_DATE()) -> CURRENT_DATE - INTERVAL '5 days'.
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
   AND COALESCE(d.VISIBLE_TO_FIELD, vis.VISIBLE_TO_FIELD, false) = true
   AND fv.VISIT_DATE >= CURRENT_DATE - INTERVAL '5 days';

-- The ingest preview, server side. Goes through V_BOUNDARY_ENTITY, so the
-- entity-model question stays in one place.
CREATE OR REPLACE VIEW CURATED.V_IMPORT_PREVIEW AS
SELECT r.IMPORT_ID,
       r.SOURCE_ROW_NO,
       r.PLAN_POINT_LABEL,
       r.LAT,
       r.LON,
       r.COORD_FORMAT_DETECTED,
       r.COORD_FIX_APPLIED,
       r.BOUNDARY_ID_RESOLVED,
       b.PROPERTY_NAME              AS BOUNDARY_PROPERTY_NAME,
       b.GEOM_ACRES,
       r.OPERATION_TEXT,
       r.OPERATION_MATCH_STATUS,
       r.OPERATION_MATCH_SCORE,
       r.CONTACT_NAME_TEXT,
       r.CONTACT_MATCH_STATUS,
       r.ROW_STATUS,
       r.VALIDATION_CODES
  FROM CURATED.PLAN_IMPORT_ROW r
  LEFT JOIN CURATED.V_BOUNDARY_ENTITY b ON b.BOUNDARY_ID = r.BOUNDARY_ID_RESOLVED;

-- Import provenance, end to end: a sampled point back to a spreadsheet row.
CREATE OR REPLACE VIEW CURATED.V_POINT_PROVENANCE AS
SELECT sp.SAMPLE_UID,
       sp.CAPTURED_TS_DEVICE,
       sp.SAMPLER_PERSON_ID,
       sp.DEVICE_ID,
       pp.PLAN_POINT_LABEL,
       pp.PLANNED_LAT, pp.PLANNED_LON,
       sp.LAT, sp.LON, sp.OFFSET_FROM_PLAN_M, sp.DEVIATION_REASON_CODE,
       sp.GEO_DERIVATION_STATE,
       ir.SOURCE_ROW_NO,
       ir.RAW_VALUES_TEXT,
       ir.RAW_VALUES_JSON,
       pi.ORIGINAL_FILENAME,
       pi.IMPORTED_BY,
       pi.IMPORTED_TS,
       pi.CONTENT_HASH
  FROM CURATED.SAMPLE_POINT sp
  LEFT JOIN CURATED.SAMPLE_PLAN_POINT pp ON pp.PLAN_POINT_ID = sp.PLAN_POINT_ID
  LEFT JOIN CURATED.PLAN_IMPORT_ROW   ir ON ir.IMPORT_ROW_ID = pp.IMPORT_ROW_ID
  LEFT JOIN CURATED.PLAN_IMPORT       pi ON pi.IMPORT_ID     = ir.IMPORT_ID;


-- ============================================================================
-- 9. REFERENCE SEEDS
--
-- The DDL creates these tables empty and the capture screen cannot render
-- without them: condition chips, deviation reasons and the protocol constants
-- are reference data by design, not constants in code.
--
-- EVERY VALUE IN 9b AND 9c IS PROPOSED, NOT DERIVED, and is carried across from
-- snowflake_bootstrap_v01.sql section 8 unchanged. Review them with someone who
-- has sampled before the crew sees them.
--
-- 9d/9e are NOT carried across unchanged: they are regenerated from
-- src/shared/codes/index.ts, which is the authority the running code uses. That
-- file has 17 codes; the Snowflake seeds have a different 17. See the wave
-- report -- the drift is real and it is not this file's to fix.
--
-- ON CONFLICT DO NOTHING throughout, so a re-run is a no-op per row rather than
-- per table. That is stricter than the Snowflake seeds' WHERE NOT EXISTS guards,
-- which skip the whole block if any row is present and therefore never add a
-- code introduced later.
-- ============================================================================

-- 9a. BCarbon v3.0 constants live HERE, not in code and not in someone's head.
--     Blocked on pre-work item 2: whether BCarbon accepts exception-based depth
--     and core evidence. If not, this row grows a column.
INSERT INTO REF.PROJECT_SAMPLING_SPEC
  (SPEC_ID, PROJECT_ID, PROTOCOL_VERSION, PERIOD_CODE,
   DEPTH_TOP_CM, DEPTH_BOTTOM_CM, DEPTH_INCREMENTS_JSON, OVERDRILL_CM,
   CORES_PER_COMPOSITE_MIN, CORES_PER_COMPOSITE_MAX, COMPOSITE_RADIUS_M,
   BD_CORE_REQUIRED, BAG_SCHEME, REQUIRED_MEDIA_ROLES,
   GPS_ACCURACY_REQUIRED_M, MIN_GPS_FIX_COUNT,
   MAX_PLAN_OFFSET_M_WARN, MAX_PLAN_OFFSET_M_BLOCK,
   DEFAULT_LAB_ID, EFFECTIVE_START)
VALUES ('SPEC_F26_BCARBON_V3', 'PROJECT_TBD', 'BCARBON_V3.0', 'F26',
        0, 30, '[[0,30]]'::jsonb, 5,
        5, 10, 2,
        true, 'ONE_BAG_PER_POINT',
        '["label_photo","core_photo","site_photo"]'::jsonb,
        10, 3,
        15, 30,
        'LAB_TBD', DATE '2026-09-01')
ON CONFLICT (SPEC_ID) DO NOTHING;
-- Depth increments: [[0,30]] is a single 0-30 cm interval. BCarbon requires the
-- SAME interval at baseline and true-up, so this value is effectively permanent
-- per project.

-- 9b. Condition chips. VALUE_TYPE 'none' throughout: chips only, no typing, in
--     gloves and wind.
INSERT INTO REF.CONDITION_CODE
  (CONDITION_CODE, CODE_SET_VERSION, CONDITION_GROUP, DISPLAY_LABEL, VALUE_TYPE, SORT_ORDER)
VALUES
  ('MOIST_DRY',       'v1', 'moisture', 'Dry',            'none', 10),
  ('MOIST_FIELD_CAP', 'v1', 'moisture', 'Field capacity', 'none', 20),
  ('MOIST_WET',       'v1', 'moisture', 'Wet',            'none', 30),
  ('MOIST_SATURATED', 'v1', 'moisture', 'Saturated',      'none', 40),
  ('RESIDUE_NONE',    'v1', 'residue',  'Bare',           'none', 50),
  ('RESIDUE_LIGHT',   'v1', 'residue',  'Light residue',  'none', 60),
  ('RESIDUE_HEAVY',   'v1', 'residue',  'Heavy residue',  'none', 70),
  ('CROP_NONE',       'v1', 'crop',     'No crop',        'none', 80),
  ('CROP_STUBBLE',    'v1', 'crop',     'Stubble',        'none', 90),
  ('CROP_COVER',      'v1', 'crop',     'Cover crop',     'none', 100),
  ('CROP_STANDING',   'v1', 'crop',     'Standing crop',  'none', 110),
  ('SOIL_ROCKY',      'v1', 'soil',     'Rocky',          'none', 120),
  ('SOIL_COMPACTED',  'v1', 'soil',     'Compacted',      'none', 130),
  ('SOIL_FROZEN',     'v1', 'soil',     'Frozen',         'none', 140),
  ('ACCESS_DRY',      'v1', 'access',   'Dry access',     'none', 150),
  ('ACCESS_MUDDY',    'v1', 'access',   'Muddy access',   'none', 160),
  ('ACCESS_RUTTED',   'v1', 'access',   'Rutted access',  'none', 170)
ON CONFLICT (CONDITION_CODE, CODE_SET_VERSION) DO NOTHING;

-- 9c. Deviation reasons. IS_SKIP_REASON = true means the plan point produced no
--     sample at all -- the Skip screen -- rather than a moved sample.
INSERT INTO REF.DEVIATION_REASON
  (DEVIATION_REASON_CODE, DISPLAY_LABEL, REQUIRES_NOTE, REQUIRES_PHOTO, IS_SKIP_REASON)
VALUES
  ('OBSTRUCTION',       'Obstruction at planned point', false, false, false),
  ('STANDING_WATER',    'Standing water',               false, false, false),
  ('STANDING_CROP',     'Standing crop',                false, false, false),
  ('ROCK_REFUSAL',      'Rock refusal',                 false, false, false),
  ('WHEEL_TRACK',       'Wheel track or headland',      false, false, false),
  ('UNSAFE_TERRAIN',    'Unsafe terrain',               true,  false, false),
  ('LIVESTOCK_PRESENT', 'Livestock present',            false, false, false),
  ('OTHER_MOVED',       'Other -- see note',            true,  false, false),
  ('ACCESS_DENIED',     'Access denied',                true,  false, true),
  ('GATE_LOCKED',       'Gate locked',                  false, true,  true),
  ('FIELD_IMPASSABLE',  'Field impassable',             false, true,  true),
  ('POINT_UNDERWATER',  'Point underwater',             false, true,  true),
  ('OTHER_SKIPPED',     'Other -- not sampled',         true,  false, true)
ON CONFLICT (DEVIATION_REASON_CODE) DO NOTHING;

-- 9d. Defect codes -- ALL SEVENTEEN from src/shared/codes/index.ts, with the
--     severities from DEFAULT_SEVERITY there. Two of these are absent from the
--     Snowflake seeds and are the reason this block was regenerated rather than
--     copied: GEOM_INVALID and OFFSET_EXCEEDED_NO_REASON.
INSERT INTO REF.DEFECT_CODE
  (DEFECT_CODE, DISPLAY_LABEL, DEFAULT_SEVERITY, RAISED_BY, RULE_DESCRIPTION)
VALUES
  ('BARCODE_DUPLICATE',       'Duplicate barcode',              'review',   'server_rule', 'Same lab_id + barcode already bound to another bag.'),
  ('BARCODE_UNREAD',          'Barcode not scanned',            'review',   'device',      'Entered manually or not captured. Never normalised in place.'),
  ('MISSING_REQUIRED_MEDIA',  'Missing required photo',         'blocking', 'server_rule', 'A required media role from the project spec has no in-app-camera photo.'),
  ('NO_GPS_FIX',              'No GPS fix',                     'blocking', 'device',      'Sample captured with no satellite fix.'),
  ('GPS_ACCURACY_EXCEEDED',   'GPS accuracy exceeded',          'review',   'server_rule', 'Accuracy worse than GPS_ACCURACY_REQUIRED_M in the project spec.'),
  ('POINT_OUTSIDE_BOUNDARY',  'Point outside boundary',         'blocking', 'server_rule', 'Point-in-polygon matched no active boundary. Usually a boundary problem. REQUIRES a geospatial backend -- not raised when GEO_DERIVATION_STATE = deferred_no_geospatial.'),
  ('PLAN_POINT_UNSAMPLED',    'Plan point never sampled',       'review',   'server_rule', 'Plan point neither sampled nor explicitly skipped at plan close.'),
  ('DEPTH_SHORTFALL',         'Depth below spec',               'review',   'device',      'Recorded depth short of the project spec interval.'),
  ('OFFSET_EXCEEDED_NO_REASON','Moved without a reason',        'review',   'server_rule', 'Offset beyond MAX_PLAN_OFFSET_M_BLOCK with no deviation reason. REQUIRES OFFSET_FROM_PLAN_M, so it cannot run when GEO_DERIVATION_STATE = deferred_no_geospatial.'),
  ('CLOCK_DRIFT_SUSPECTED',   'Device clock drift',             'review',   'server_rule', 'Device and server timestamps disagree beyond tolerance for the recorded uptime.'),
  ('LATE_SYNC',               'Synced late',                    'advisory', 'server_rule', 'Record reached the server well after capture. Operational signal, not a data fault.'),
  ('EXIF_POSITION_MISMATCH',  'Photo position disagrees',       'review',   'server_rule', 'Photo EXIF fix disagrees with the app fix beyond threshold. Two sources disagreeing is a finding.'),
  ('MEDIA_GALLERY_SOURCED',   'Gallery photo on required role', 'review',   'server_rule', 'A gallery photo satisfied a required role. The app should prevent this; the rule catches when it did not.'),
  ('MANUAL_POSITION',         'Position entered manually',      'advisory', 'device',      'Position from a dropped map pin rather than a satellite fix.'),
  ('GEOM_INVALID',            'Coordinate did not parse',       'blocking', 'server_rule', 'LAT/LON did not resolve to a valid position. Computable without geospatial support, so this rule runs on every backend.'),
  ('IMPORT_OPERATION_UNRESOLVED','Uploaded operation matched nothing', 'review',  'server_rule', 'PLAN_IMPORT_ROW.OPERATION_MATCH_STATUS = unmatched. An analyst decides whether this is a new operation or another spelling of an existing one. The upload never creates it.'),
  ('IMPORT_CONTACT_UNRESOLVED','Uploaded contact matched nothing',   'advisory','server_rule', 'PLAN_IMPORT_ROW.CONTACT_MATCH_STATUS = unmatched.')
ON CONFLICT (DEFECT_CODE) DO NOTHING;

-- 9e. WHICH DEFECTS REACH A CREW NEXT MORNING. Addendum 4.2.
--     This table shipped EMPTY in the v02 Snowflake addendum, and
--     COALESCE(..., FALSE) means an empty row set hides EVERY defect from the
--     field. Seeded here for all seventeen codes, matching VISIBLE_TO_FIELD in
--     src/shared/codes/index.ts. Section 10's check fails if a code is missing.
--     Guidance is written for a phone held in wind, not for a queue.
INSERT INTO REF.DEFECT_FIELD_VISIBILITY (DEFECT_CODE, VISIBLE_TO_FIELD, FIELD_GUIDANCE)
VALUES
  ('BARCODE_DUPLICATE',      true,  'This bag''s barcode is on another bag. Check the label and re-scan.'),
  ('BARCODE_UNREAD',         true,  'The barcode did not read. Type it in or photograph the label.'),
  ('MISSING_REQUIRED_MEDIA', true,  'A required photo is missing for this point. Revisit and use the in-app camera.'),
  ('NO_GPS_FIX',             true,  'No satellite fix was recorded here. Re-visit and capture a fix.'),
  ('GPS_ACCURACY_EXCEEDED',  true,  'The fix was weaker than the protocol asks for. Revisit under open sky if practical.'),
  ('POINT_OUTSIDE_BOUNDARY', true,  'This point fell outside every field boundary. Usually a boundary problem -- flag it, do not re-drill without checking.'),
  ('PLAN_POINT_UNSAMPLED',   true,  'This planned point has no sample yet. Sample it or record a skip reason.'),
  ('DEPTH_SHORTFALL',        true,  'Recorded depth is short of the protocol. Note the refusal reason.'),
  -- Office-only. A crew cannot act on any of these, and pushing them down
  -- trains people to ignore the list.
  ('OFFSET_EXCEEDED_NO_REASON',   false, NULL),
  ('CLOCK_DRIFT_SUSPECTED',       false, NULL),
  ('LATE_SYNC',                   false, NULL),
  ('EXIF_POSITION_MISMATCH',      false, NULL),
  ('MEDIA_GALLERY_SOURCED',       false, NULL),
  ('MANUAL_POSITION',             false, NULL),
  ('GEOM_INVALID',                false, NULL),
  ('IMPORT_OPERATION_UNRESOLVED', false, NULL),
  ('IMPORT_CONTACT_UNRESOLVED',   false, NULL)
ON CONFLICT (DEFECT_CODE) DO NOTHING;

-- 9f. The lab. BARCODE_SYMBOLOGY stays NULL by design until Agidata confirms it
--     -- pre-work item 1. Nothing depends on the answer; the design is
--     symbology-agnostic. BARCODE_REUSED drives the lab-join date window.
INSERT INTO REF.LAB (LAB_ID, LAB_NAME, BARCODE_SYMBOLOGY, BARCODE_PATTERN, BARCODE_REUSED)
VALUES ('LAB_TBD', 'Lab pending confirmation', NULL, NULL, NULL)
ON CONFLICT (LAB_ID) DO NOTHING;


-- ============================================================================
-- 10. DEPLOY-TIME ASSERTIONS
--
-- These RAISE, so they fail the migration and therefore the deploy. That is the
-- intent: a green deploy behind a half-seeded schema is worse than a red one
-- that names the problem. The runner wraps the file in one transaction, so a
-- failure here rolls the whole thing back.
--
-- Only invariants that CANNOT be expressed as a constraint live here. Everything
-- else is a constraint on the table, because a constraint holds continuously and
-- an assertion holds only at deploy time.
-- ============================================================================

-- 10a. EVERY DEFECT CODE HAS A FIELD-VISIBILITY DECISION.
--      `REF.DEFECT_FIELD_VISIBILITY` shipped EMPTY in the v02 Snowflake
--      addendum, and because the defect writers use
--      COALESCE(vis.VISIBLE_TO_FIELD, FALSE), an empty table silently hid every
--      defect from the field. Nothing failed. This is the check that would have
--      caught it, and it is an assertion rather than a SELECT precisely because
--      a SELECT nobody reads is what let the bug ship.
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(c.DEFECT_CODE, ', ' ORDER BY c.DEFECT_CODE) INTO missing
    FROM REF.DEFECT_CODE c
    LEFT JOIN REF.DEFECT_FIELD_VISIBILITY v ON v.DEFECT_CODE = c.DEFECT_CODE
   WHERE v.DEFECT_CODE IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'REF.DEFECT_FIELD_VISIBILITY has no decision for: %. Every defect without a '
      'row here is invisible to the field, silently.', missing;
  END IF;
END $$;

-- 10b. THE REFERENCE TABLES THE CAPTURE SCREEN NEEDS ARE NOT EMPTY.
--      Condition chips, deviation reasons and the protocol constants are
--      reference data by design, not constants in code -- so an empty table is
--      a screen with nothing on it, not a cosmetic gap.
DO $$
DECLARE empty_tables text := '';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM REF.PROJECT_SAMPLING_SPEC)   THEN empty_tables := empty_tables || 'PROJECT_SAMPLING_SPEC '; END IF;
  IF NOT EXISTS (SELECT 1 FROM REF.CONDITION_CODE)          THEN empty_tables := empty_tables || 'CONDITION_CODE '; END IF;
  IF NOT EXISTS (SELECT 1 FROM REF.DEVIATION_REASON)        THEN empty_tables := empty_tables || 'DEVIATION_REASON '; END IF;
  IF NOT EXISTS (SELECT 1 FROM REF.DEFECT_CODE)             THEN empty_tables := empty_tables || 'DEFECT_CODE '; END IF;
  IF NOT EXISTS (SELECT 1 FROM REF.DEFECT_FIELD_VISIBILITY) THEN empty_tables := empty_tables || 'DEFECT_FIELD_VISIBILITY '; END IF;
  IF NOT EXISTS (SELECT 1 FROM REF.LAB)                     THEN empty_tables := empty_tables || 'LAB '; END IF;
  IF empty_tables <> '' THEN
    RAISE EXCEPTION 'REF tables seeded empty: %', empty_tables;
  END IF;
END $$;

-- 10c. NO SAMPLE CLAIMS A FULL PASS IT DID NOT PERFORM.
--      SAMPLE_POINT_SCREENED_REQUIRES_GEO enforces this continuously for new
--      rows. This assertion covers the one case the constraint cannot: a future
--      migration that loosened or dropped it. It is cheap and it is the single
--      most important property of this schema on a backend without geospatial.
DO $$
DECLARE bad bigint;
BEGIN
  SELECT count(*) INTO bad
    FROM CURATED.SAMPLE_POINT
   WHERE REVIEW_STATE = 'screened'
     AND GEO_DERIVATION_STATE NOT IN ('derived_geodesic', 'derived_planar');
  IF bad > 0 THEN
    RAISE EXCEPTION
      '% sample(s) are REVIEW_STATE=screened without a derived GEO_DERIVATION_STATE. '
      'Those rows assert that every server rule passed when the boundary and offset '
      'checks never ran. Expected state on this backend is screened_partial.', bad;
  END IF;
END $$;


-- ============================================================================
-- 11. INFORMATIONAL QUERIES -- run by hand after a deploy, read all of it.
--
-- Kept in this file so they cannot drift from the DDL they inspect, and kept
-- COMMENTED so they do not run on every deploy. The assertions above are what
-- gates a deploy; these are what a human reads.
--
--   -- Every object this file should have created.
--   SELECT TABLE_SCHEMA, TABLE_TYPE, COUNT(*) AS OBJECTS
--     FROM INFORMATION_SCHEMA.TABLES
--    WHERE TABLE_SCHEMA IN ('raw', 'ref', 'curated', 'meta')
--    GROUP BY TABLE_SCHEMA, TABLE_TYPE ORDER BY TABLE_SCHEMA, TABLE_TYPE;
--
--   -- What the migration runner has applied, and how many times.
--   SELECT MIGRATION_ID, STATEMENT_COUNT, APPLY_COUNT, APPLIED_TS,
--          left(CONTENT_SHA256, 12) AS SHA
--     FROM META.SCHEMA_MIGRATION ORDER BY FIRST_APPLIED_TS;
--
--   -- Reference data counts. Zero anywhere means a screen with nothing on it.
--   SELECT 'PROJECT_SAMPLING_SPEC' AS T, COUNT(*) AS N FROM REF.PROJECT_SAMPLING_SPEC UNION ALL
--   SELECT 'CONDITION_CODE',             COUNT(*)      FROM REF.CONDITION_CODE          UNION ALL
--   SELECT 'DEVIATION_REASON',           COUNT(*)      FROM REF.DEVIATION_REASON        UNION ALL
--   SELECT 'DEFECT_CODE',                COUNT(*)      FROM REF.DEFECT_CODE             UNION ALL
--   SELECT 'DEFECT_FIELD_VISIBILITY',    COUNT(*)      FROM REF.DEFECT_FIELD_VISIBILITY UNION ALL
--   SELECT 'LAB',                        COUNT(*)      FROM REF.LAB;
--
--   -- GEOSPATIAL ASSURANCE. The numbers to read after any pilot day. On this
--   -- backend every derived row should read 'clean_geo_unverified' or
--   -- 'needs_review', and NEVER 'clean_verified'.
--   SELECT ASSURANCE_VERDICT, GEO_DERIVATION_STATE, COUNT(*) AS N
--     FROM CURATED.V_SAMPLE_GEO_ASSURANCE
--    GROUP BY ASSURANCE_VERDICT, GEO_DERIVATION_STATE ORDER BY N DESC;
--
--   -- Per-batch: what ran, and what did not.
--   SELECT SYNC_BATCH_ID, BACKEND, GEO_CAPABILITY, STEPS_SKIPPED, STARTED_TS
--     FROM CURATED.DERIVATION_RUN ORDER BY STARTED_TS DESC LIMIT 50;
--
--   -- Boundary cache. EMPTY IS EXPECTED right after a first deploy, and it is
--   -- also a blocker: with no boundary rows /ingest/validate resolves every row
--   -- to no boundary and blocks the file. The loader is not written -- see the
--   -- wave report.
--   SELECT SOURCE_KIND, STATUS, COUNT(*) AS N
--     FROM CURATED.BOUNDARY_CACHE GROUP BY SOURCE_KIND, STATUS;
-- ============================================================================
