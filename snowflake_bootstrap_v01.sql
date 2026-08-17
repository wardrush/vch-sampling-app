-- ============================================================================
-- VCH_SAMPLING :: bootstrap -- v01
-- 2026-08-17 -- Viridi Data
--
-- Stands up a NEW, self-contained database for the sampling subject area:
-- warehouse, resource monitor, database, schemas, role, grants, service user
-- with key-pair auth, network policies, cross-database pass-throughs, and
-- reference seed data.
--
-- RUN ORDER:
--   1. snowflake_bootstrap_v01.sql   sections 0-7   (this file)
--   2. snowflake_sampling_v01.sql                   (change its USE DATABASE line)
--   3. snowflake_v02_addendum.sql                   (change its USE DATABASE line)
--   4. snowflake_bootstrap_v01.sql   sections 8-9   (this file, seeds + verify)
--
-- Sections 8-9 come AFTER the DDL because they seed tables the DDL creates.
--
-- Sections 1-6 need ACCOUNTADMIN (resource monitor, user, network policy).
-- Everything else runs as SYSADMIN.
--
-- Conventions inherited from the existing VCH_GEO build. Do not deviate:
--   * Schemas RAW / REF / CURATED / META
--   * Upsert-never-delete -- which is why the app role is NOT granted DELETE
--   * Bad input degrades, it does not fail the batch
-- ============================================================================


-- ============================================================================
-- 0. EDIT THIS BLOCK, THEN FIND-AND-REPLACE THROUGHOUT THE FILE
--
-- Every name below appears verbatim wherever it is used. One find-and-replace
-- per line and the file is configured. Nothing else needs changing.
--
--   VCH_SAMPLING        the new database
--   WH_SAMPLING_XS      the new warehouse
--   RM_SAMPLING         the resource monitor
--   SAMPLING_APP_RW     the application role
--   SVC_SAMPLING_APP    the service user the Netlify functions authenticate as
--   NP_SAMPLING_SERVICE network policy on the service user
--   NP_SAMPLING_HUMAN   network policy on human users
--   VCH_GEO             the EXISTING database holding boundary/property/lab
--
-- Confirm the proposed names against what Section 1 discovery shows you.
-- VCH_GEO conventions are house style; do not invent a second one.
-- ============================================================================


-- ============================================================================
-- 1. DISCOVERY -- read-only. Run this first and read the output.
--
-- Nothing below creates anything. The purpose is to confirm names, find where
-- boundary/property/lab actually live, and check nothing collides.
-- ============================================================================

SHOW DATABASES;
SHOW WAREHOUSES;
SHOW ROLES;
SHOW NETWORK POLICIES;
SHOW RESOURCE MONITORS;
SELECT CURRENT_ACCOUNT(), CURRENT_REGION(), CURRENT_ROLE(), CURRENT_USER();

-- Which edition? Governs Time Travel depth, network rules, and TYPE = SERVICE.
SELECT SYSTEM$BOOTSTRAP_DATA_REQUEST('ACCOUNT');

-- WHERE DO BOUNDARY / PROPERTY / LAB_RESULT ACTUALLY LIVE?
-- Section 7 cannot be written until this is answered. The DDL assumes Phase 1
-- entity-model names (BOUNDARY, PROPERTY, LAB_RESULT); the live warehouse may
-- still use legacy FACT_BORDER naming.
SELECT TABLE_CATALOG, TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
  FROM VCH_GEO.INFORMATION_SCHEMA.TABLES
 WHERE TABLE_NAME ILIKE ANY ('%BOUNDARY%', '%BORDER%', '%PROPERTY%',
                             '%LAB_RESULT%', '%PARCEL%', '%FIELD%')
 ORDER BY TABLE_SCHEMA, TABLE_NAME;

-- Then the columns of whatever those turn out to be. Section 7 needs:
--   boundary : BOUNDARY_ID, STATUS, GEOG, GEOM_ACRES, PROPERTY_ID
--   property : PROPERTY_ID, PROPERTY_NAME
--   lab      : LAB_RESULT_ID, LAB_ID, LAB_BARCODE, RECEIVED_DATE,
--              TOC_PCT, TC_PCT, CCE_PCT, BULK_DENSITY_G_CM3, OM_PCT
SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE
  FROM VCH_GEO.INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_NAME IN ('BOUNDARY', 'PROPERTY', 'LAB_RESULT', 'FACT_BORDER')
 ORDER BY TABLE_NAME, ORDINAL_POSITION;


-- ============================================================================
-- 2. WAREHOUSE AND RESOURCE MONITOR                        [ACCOUNTADMIN]
--
-- XS is genuinely right here. A sync batch is sub-second; a 5,000-row ingest
-- validation is a few seconds. The workload is bursty and tiny, and every
-- Netlify function invocation is a cold start, so what matters is AUTO_RESUME
-- latency rather than size.
-- ============================================================================

USE ROLE ACCOUNTADMIN;

CREATE RESOURCE MONITOR IF NOT EXISTS RM_SAMPLING
  WITH CREDIT_QUOTA = 50                  -- << set from your own budget
       FREQUENCY = MONTHLY
       START_TIMESTAMP = IMMEDIATELY
  TRIGGERS ON 75  PERCENT DO NOTIFY
           ON 90  PERCENT DO NOTIFY
           ON 100 PERCENT DO SUSPEND
           ON 110 PERCENT DO SUSPEND_IMMEDIATE;

CREATE WAREHOUSE IF NOT EXISTS WH_SAMPLING_XS
  WITH WAREHOUSE_SIZE       = 'XSMALL'
       AUTO_SUSPEND         = 60
       AUTO_RESUME          = TRUE
       INITIALLY_SUSPENDED  = TRUE
       COMMENT              = 'Sampling app: sync batches, ingest validation, nightly derivation';

ALTER WAREHOUSE WH_SAMPLING_XS SET RESOURCE_MONITOR = RM_SAMPLING;


-- ============================================================================
-- 3. DATABASE AND SCHEMAS                                     [SYSADMIN]
--
-- All four schemas are required: the attached DDL writes to RAW, REF and
-- CURATED, and META is part of the inherited convention.
-- ============================================================================

USE ROLE SYSADMIN;

CREATE DATABASE IF NOT EXISTS VCH_SAMPLING
  COMMENT = 'Sampling subject area. Self-contained; reads boundary/property/lab from VCH_GEO via pass-through views in CURATED.';

-- Time Travel. 7 days needs Enterprise or above; on Standard the max is 1.
-- If this errors, set it to 1 and note the reduced recovery window.
ALTER DATABASE VCH_SAMPLING SET DATA_RETENTION_TIME_IN_DAYS = 7;

CREATE SCHEMA IF NOT EXISTS VCH_SAMPLING.RAW
  COMMENT = 'Verbatim device payloads and uploaded files. Never edited, never overwritten.';
CREATE SCHEMA IF NOT EXISTS VCH_SAMPLING.REF
  COMMENT = 'Versioned reference data. Protocol constants live here, not in code.';
CREATE SCHEMA IF NOT EXISTS VCH_SAMPLING.CURATED
  COMMENT = 'The modelled layer. Rebuildable in full from RAW.';
CREATE SCHEMA IF NOT EXISTS VCH_SAMPLING.META
  COMMENT = 'Load metadata and operational bookkeeping.';

-- Snowflake creates a PUBLIC schema with every database. Nothing uses it.
DROP SCHEMA IF EXISTS VCH_SAMPLING.PUBLIC;


-- ============================================================================
-- 4. APPLICATION ROLE AND GRANTS                              [SYSADMIN]
--
-- Least privilege, and one deliberate omission: the app role gets SELECT,
-- INSERT and UPDATE but NOT DELETE, and no TRUNCATE. Corrections are new rows
-- carrying SUPERSEDES_*; nothing in the write path should ever need to delete.
-- If a function fails for want of DELETE, that is a design bug worth finding.
--
-- FUTURE grants are issued BEFORE the DDL runs, so every table the DDL creates
-- inherits them automatically. The ALL grants at the end are the catch-up for
-- anything created out of order.
-- ============================================================================

USE ROLE SECURITYADMIN;
CREATE ROLE IF NOT EXISTS SAMPLING_APP_RW
  COMMENT = 'Read/write for the sampling app service user. No DELETE by design.';
GRANT ROLE SAMPLING_APP_RW TO ROLE SYSADMIN;

USE ROLE SYSADMIN;

GRANT USAGE ON WAREHOUSE WH_SAMPLING_XS TO ROLE SAMPLING_APP_RW;
GRANT USAGE ON DATABASE  VCH_SAMPLING    TO ROLE SAMPLING_APP_RW;
GRANT USAGE ON SCHEMA VCH_SAMPLING.RAW     TO ROLE SAMPLING_APP_RW;
GRANT USAGE ON SCHEMA VCH_SAMPLING.REF     TO ROLE SAMPLING_APP_RW;
GRANT USAGE ON SCHEMA VCH_SAMPLING.CURATED TO ROLE SAMPLING_APP_RW;
GRANT USAGE ON SCHEMA VCH_SAMPLING.META    TO ROLE SAMPLING_APP_RW;

-- RAW: write-once. Insert and read; never update, never delete.
GRANT SELECT, INSERT        ON FUTURE TABLES IN SCHEMA VCH_SAMPLING.RAW     TO ROLE SAMPLING_APP_RW;
-- CURATED: MERGE needs INSERT + UPDATE. No DELETE.
GRANT SELECT, INSERT, UPDATE ON FUTURE TABLES IN SCHEMA VCH_SAMPLING.CURATED TO ROLE SAMPLING_APP_RW;
GRANT SELECT, INSERT, UPDATE ON FUTURE TABLES IN SCHEMA VCH_SAMPLING.META    TO ROLE SAMPLING_APP_RW;
-- REF: read-only to the app. Reference data is loaded by an admin, not the app.
GRANT SELECT                 ON FUTURE TABLES IN SCHEMA VCH_SAMPLING.REF     TO ROLE SAMPLING_APP_RW;

GRANT SELECT ON FUTURE VIEWS IN SCHEMA VCH_SAMPLING.CURATED TO ROLE SAMPLING_APP_RW;
GRANT SELECT ON FUTURE VIEWS IN SCHEMA VCH_SAMPLING.REF     TO ROLE SAMPLING_APP_RW;
GRANT USAGE  ON FUTURE PROCEDURES IN SCHEMA VCH_SAMPLING.CURATED TO ROLE SAMPLING_APP_RW;

-- Catch-up for anything already created.
GRANT SELECT, INSERT         ON ALL TABLES IN SCHEMA VCH_SAMPLING.RAW     TO ROLE SAMPLING_APP_RW;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA VCH_SAMPLING.CURATED TO ROLE SAMPLING_APP_RW;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA VCH_SAMPLING.META    TO ROLE SAMPLING_APP_RW;
GRANT SELECT                 ON ALL TABLES IN SCHEMA VCH_SAMPLING.REF     TO ROLE SAMPLING_APP_RW;
GRANT SELECT ON ALL VIEWS      IN SCHEMA VCH_SAMPLING.CURATED TO ROLE SAMPLING_APP_RW;
GRANT USAGE  ON ALL PROCEDURES IN SCHEMA VCH_SAMPLING.CURATED TO ROLE SAMPLING_APP_RW;


-- ============================================================================
-- 5. SERVICE USER WITH KEY-PAIR AUTH                       [ACCOUNTADMIN]
--
-- Generate the keypair LOCALLY, on your own machine, before running this.
-- The private key never enters Snowflake, never enters a browser, and never
-- enters this repository.
--
--   openssl genrsa 2048 \
--     | openssl pkcs8 -topk8 -inform PEM -out svc_sampling_app.p8 -nocrypt
--   openssl rsa -in svc_sampling_app.p8 -pubout -out svc_sampling_app.pub
--
-- -nocrypt gives an unencrypted key, which is what a Netlify environment
-- variable can actually use. Treat the .p8 as a credential: it goes into the
-- Netlify env var and nowhere else. Never commit it.
--
-- Then paste the BODY of svc_sampling_app.pub below -- the base64 between the
-- BEGIN/END lines, with the header, footer and newlines stripped.
--
-- Verify TYPE = SERVICE is supported on your edition. If it is not, create the
-- user without it; key-pair auth still works, and you then also want
-- MUST_CHANGE_PASSWORD = FALSE and no password set.
-- ============================================================================

USE ROLE ACCOUNTADMIN;

CREATE USER IF NOT EXISTS SVC_SAMPLING_APP
  TYPE              = SERVICE
  DEFAULT_ROLE      = SAMPLING_APP_RW
  DEFAULT_WAREHOUSE = WH_SAMPLING_XS
  DEFAULT_NAMESPACE = VCH_SAMPLING.CURATED
  COMMENT           = 'Netlify Functions -> Snowflake SQL API v2. Key-pair JWT only.';

ALTER USER SVC_SAMPLING_APP SET RSA_PUBLIC_KEY = 'PASTE_PUBLIC_KEY_BODY_HERE';

GRANT ROLE SAMPLING_APP_RW TO USER SVC_SAMPLING_APP;

-- Record the fingerprint. The JWT's `iss` claim needs it (Section 9).
DESC USER SVC_SAMPLING_APP;


-- ============================================================================
-- 6. NETWORK POLICIES -- US only, everything else denied  [ACCOUNTADMIN]
--
-- READ THIS BEFORE RUNNING. The intent is "nothing outside the US reaches this
-- account." Snowflake cannot express that literally, and pretending otherwise
-- produces a policy that either blocks the app or protects nothing.
--
-- Two facts that shape what follows:
--
--   1. ALLOWED_IP_LIST is deny-by-default. Anything not listed is already
--      blocked. You do not need -- and should not write -- a BLOCKED_IP_LIST.
--
--   2. There is no country primitive. "US only" has to be CIDR. Enumerating US
--      IP space is tens of thousands of prefixes that churn weekly and will
--      exceed the per-policy entry cap.
--
-- So US-only is built from the two sets that are actually knowable:
--
--   HUMAN  -- your office and VPN egress. Small, static, genuinely tight.
--   SERVICE -- the cloud region the Netlify functions egress from. Netlify
--      Functions run on AWS Lambda with dynamic addresses, so this is
--      region-scoped, not host-scoped. It is US-only by construction and it is
--      broad. Be honest about what it buys: it stops a stolen key being used
--      from outside US cloud infrastructure, and nothing finer than that. The
--      key-pair JWT with a short lifetime is carrying most of the real load.
--
-- Generate the service list -- filtered to US regions, EC2 service, then
-- aggregated to the shortest covering prefix set:
--
--   curl -s https://ip-ranges.amazonaws.com/ip-ranges.json \
--     | jq -r '.prefixes[]
--              | select(.region | startswith("us-"))
--              | select(.service == "EC2")
--              | .ip_prefix' \
--     | sort -u | aggregate6
--
-- Count the result before pasting it. If it exceeds the policy entry cap,
-- narrow to the single region Netlify actually egresses from rather than
-- widening the prefixes -- confirm that region with Netlify support first.
--
-- IF YOU CANNOT GET A WORKABLE LIST: skip the service policy entirely, leave
-- the human policy in place, and let key-pair JWT carry the service path. That
-- is a defensible position, stated plainly. What is NOT defensible is quietly
-- widening the list to 0.0.0.0/0 to make a deploy succeed.
-- ============================================================================

-- 6a. Humans. Tight, static, and the one that actually restricts anything.
CREATE NETWORK POLICY IF NOT EXISTS NP_SAMPLING_HUMAN
  ALLOWED_IP_LIST = (
    '203.0.113.0/24'      -- << office egress. REPLACE.
   ,'198.51.100.7/32'     -- << VPN egress.    REPLACE.
  )
  COMMENT = 'Human access to the sampling database: office and VPN only.';

-- 6b. The service user. US cloud regions only, from the command above.
CREATE NETWORK POLICY IF NOT EXISTS NP_SAMPLING_SERVICE
  ALLOWED_IP_LIST = (
    'REPLACE_WITH_AGGREGATED_US_REGION_CIDRS'
  )
  COMMENT = 'SVC_SAMPLING_APP: US cloud egress ranges only. Deny-by-default.';

-- Attach per user. A user-level policy overrides the account-level one, which
-- is exactly why these are separate: the service path must not inherit the
-- human list, and the humans must not inherit the broad cloud list.
ALTER USER SVC_SAMPLING_APP SET NETWORK_POLICY = NP_SAMPLING_SERVICE;
-- ALTER USER <your_human_user> SET NETWORK_POLICY = NP_SAMPLING_HUMAN;

-- VERIFY BEFORE YOU WALK AWAY. Locking yourself out of Snowflake with a
-- network policy is a support ticket, not a rollback. Open a second session in
-- a private window and confirm you can still log in.
SHOW NETWORK POLICIES;


-- ============================================================================
-- 7. CROSS-DATABASE PASS-THROUGHS -- the part that breaks if skipped
--
-- A new empty database does not contain CURATED.BOUNDARY, CURATED.PROPERTY or
-- CURATED.LAB_RESULT. Four objects in the attached DDL depend on all three:
--
--   SP_RESOLVE_SAMPLE_BOUNDARY   BOUNDARY (BOUNDARY_ID, STATUS, GEOG)
--   V_PLAN_COMPLETION            BOUNDARY
--   V_IMPORT_PREVIEW             BOUNDARY (+ GEOM_ACRES, PROPERTY_ID), PROPERTY
--   V_BAG_LAB_MATCH              LAB_RESULT
--
-- These views give the DDL the local names it expects while the data stays in
-- VCH_GEO. Read-only by construction: no grant below permits a write back.
--
-- COLUMN NAMES ON THE RIGHT OF EACH `AS` ARE ASSUMPTIONS. Correct them from
-- Section 1's output before running. If the live tables are FACT_BORDER-era,
-- this is the ONLY place that needs to change -- which is the point of doing
-- it as views rather than editing the DDL.
-- ============================================================================

USE ROLE SYSADMIN;
USE DATABASE VCH_SAMPLING;

CREATE OR REPLACE VIEW CURATED.BOUNDARY AS
SELECT BOUNDARY_ID,          -- << confirm: may be BORDER_ID
       PROPERTY_ID,
       STATUS,               -- SP_RESOLVE_SAMPLE_BOUNDARY filters STATUS = 'active'
       GEOG,                 -- must be GEOGRAPHY; ST_WITHIN depends on it
       GEOM_ACRES
  FROM VCH_GEO.CURATED.BOUNDARY;

CREATE OR REPLACE VIEW CURATED.PROPERTY AS
SELECT PROPERTY_ID,
       PROPERTY_NAME
  FROM VCH_GEO.CURATED.PROPERTY;

CREATE OR REPLACE VIEW CURATED.LAB_RESULT AS
SELECT LAB_RESULT_ID,
       LAB_ID,
       LAB_BARCODE,
       RECEIVED_DATE,
       TOC_PCT, TC_PCT, CCE_PCT, BULK_DENSITY_G_CM3, OM_PCT
  FROM VCH_GEO.CURATED.LAB_RESULT;

-- The app role needs to read through to the source objects.
GRANT USAGE  ON DATABASE VCH_GEO         TO ROLE SAMPLING_APP_RW;
GRANT USAGE  ON SCHEMA   VCH_GEO.CURATED TO ROLE SAMPLING_APP_RW;
GRANT SELECT ON TABLE VCH_GEO.CURATED.BOUNDARY   TO ROLE SAMPLING_APP_RW;
GRANT SELECT ON TABLE VCH_GEO.CURATED.PROPERTY   TO ROLE SAMPLING_APP_RW;
GRANT SELECT ON TABLE VCH_GEO.CURATED.LAB_RESULT TO ROLE SAMPLING_APP_RW;

-- Prove all three resolve before deploying the DDL on top of them.
SELECT COUNT(*) AS boundary_rows   FROM CURATED.BOUNDARY;
SELECT COUNT(*) AS property_rows   FROM CURATED.PROPERTY;
SELECT COUNT(*) AS lab_result_rows FROM CURATED.LAB_RESULT;


-- ============================================================================
-- ****  STOP. DEPLOY THE DDL NOW, THEN CONTINUE AT SECTION 8.  ****
--
--   1. Edit snowflake_sampling_v01.sql line 16:  USE DATABASE VCH_SAMPLING;
--   2. Edit snowflake_v02_addendum.sql line 18:  USE DATABASE VCH_SAMPLING;
--      That one line is the only change either file needs. Every other object
--      reference in both is a two-part SCHEMA.TABLE name and ports as-is.
--   3. Run v01, then the addendum, in that order.
-- ============================================================================


-- ============================================================================
-- 8. REFERENCE SEED DATA                                      [SYSADMIN]
--
-- The DDL creates these tables empty. The app cannot render a capture screen
-- without them: condition chips, deviation reasons and the protocol constants
-- are all reference data by design, not constants in code.
--
-- EVERY VALUE IN 8b AND 8c IS PROPOSED, NOT DERIVED. The source documents
-- specify the SHAPE of these code sets but never enumerate them. Review them
-- with someone who has sampled before the crew sees them -- and expect the
-- pilot to tell you which codes nobody ever taps.
--
-- Each block is guarded so a re-run is a no-op. Snowflake does not enforce
-- primary keys, so without the guard a second run silently duplicates.
-- ============================================================================

USE ROLE SYSADMIN;
USE DATABASE VCH_SAMPLING;
USE WAREHOUSE WH_SAMPLING_XS;

-- 8a. The project sampling spec. BCarbon v3.0 constants live HERE, not in
--     code and not in someone's head. Adjust PROJECT_ID and the period.
--     Blocked on pre-work item 2: whether BCarbon accepts exception-based
--     depth and core evidence. If not, this row grows a column.
INSERT INTO REF.PROJECT_SAMPLING_SPEC
  (SPEC_ID, PROJECT_ID, PROTOCOL_VERSION, PERIOD_CODE,
   DEPTH_TOP_CM, DEPTH_BOTTOM_CM, DEPTH_INCREMENTS_JSON, OVERDRILL_CM,
   CORES_PER_COMPOSITE_MIN, CORES_PER_COMPOSITE_MAX, COMPOSITE_RADIUS_M,
   BD_CORE_REQUIRED, BAG_SCHEME, REQUIRED_MEDIA_ROLES,
   GPS_ACCURACY_REQUIRED_M, MIN_GPS_FIX_COUNT,
   MAX_PLAN_OFFSET_M_WARN, MAX_PLAN_OFFSET_M_BLOCK,
   DEFAULT_LAB_ID, EFFECTIVE_START)
SELECT 'SPEC_F26_BCARBON_V3', 'PROJECT_TBD', 'BCARBON_V3.0', 'F26',
       0, 30, PARSE_JSON('[[0,30]]'), 5,
       5, 10, 2,
       TRUE, 'ONE_BAG_PER_POINT',
       ARRAY_CONSTRUCT('label_photo', 'core_photo', 'site_photo'),
       10, 3,
       15, 30,
       'LAB_TBD', '2026-09-01'
WHERE NOT EXISTS (SELECT 1 FROM REF.PROJECT_SAMPLING_SPEC
                   WHERE SPEC_ID = 'SPEC_F26_BCARBON_V3');
-- Depth increments: [[0,30]] is a single 0-30 cm interval. If the project
-- splits, use [[0,15],[15,30]] -- and note BCarbon requires the SAME interval
-- at baseline and true-up, so this value is effectively permanent per project.

-- 8b. Condition chips. VALUE_TYPE is 'none' throughout: the capture screen is
--     chips only, no typing, in gloves and wind.
INSERT INTO REF.CONDITION_CODE
  (CONDITION_CODE, CODE_SET_VERSION, CONDITION_GROUP, DISPLAY_LABEL, VALUE_TYPE, SORT_ORDER)
SELECT * FROM VALUES
  ('MOIST_DRY',           'v1', 'moisture', 'Dry',                'none', 10),
  ('MOIST_FIELD_CAP',     'v1', 'moisture', 'Field capacity',     'none', 20),
  ('MOIST_WET',           'v1', 'moisture', 'Wet',                'none', 30),
  ('MOIST_SATURATED',     'v1', 'moisture', 'Saturated',          'none', 40),
  ('RESIDUE_NONE',        'v1', 'residue',  'Bare',               'none', 50),
  ('RESIDUE_LIGHT',       'v1', 'residue',  'Light residue',      'none', 60),
  ('RESIDUE_HEAVY',       'v1', 'residue',  'Heavy residue',      'none', 70),
  ('CROP_NONE',           'v1', 'crop',     'No crop',            'none', 80),
  ('CROP_STUBBLE',        'v1', 'crop',     'Stubble',            'none', 90),
  ('CROP_COVER',          'v1', 'crop',     'Cover crop',         'none', 100),
  ('CROP_STANDING',       'v1', 'crop',     'Standing crop',      'none', 110),
  ('SOIL_ROCKY',          'v1', 'soil',     'Rocky',              'none', 120),
  ('SOIL_COMPACTED',      'v1', 'soil',     'Compacted',          'none', 130),
  ('SOIL_FROZEN',         'v1', 'soil',     'Frozen',             'none', 140),
  ('ACCESS_DRY',          'v1', 'access',   'Dry access',         'none', 150),
  ('ACCESS_MUDDY',        'v1', 'access',   'Muddy access',       'none', 160),
  ('ACCESS_RUTTED',       'v1', 'access',   'Rutted access',      'none', 170)
WHERE NOT EXISTS (SELECT 1 FROM REF.CONDITION_CODE);

-- 8c. Deviation reasons. IS_SKIP_REASON = TRUE means the plan point produced
--     no sample at all -- the Skip screen -- rather than a moved sample.
INSERT INTO REF.DEVIATION_REASON
  (DEVIATION_REASON_CODE, DISPLAY_LABEL, REQUIRES_NOTE, REQUIRES_PHOTO, IS_SKIP_REASON)
SELECT * FROM VALUES
  ('OBSTRUCTION',       'Obstruction at planned point', FALSE, FALSE, FALSE),
  ('STANDING_WATER',    'Standing water',               FALSE, FALSE, FALSE),
  ('STANDING_CROP',     'Standing crop',                FALSE, FALSE, FALSE),
  ('ROCK_REFUSAL',      'Rock refusal',                 FALSE, FALSE, FALSE),
  ('WHEEL_TRACK',       'Wheel track or headland',      FALSE, FALSE, FALSE),
  ('UNSAFE_TERRAIN',    'Unsafe terrain',               TRUE,  FALSE, FALSE),
  ('LIVESTOCK_PRESENT', 'Livestock present',            FALSE, FALSE, FALSE),
  ('OTHER_MOVED',       'Other -- see note',            TRUE,  FALSE, FALSE),
  ('ACCESS_DENIED',     'Access denied',                TRUE,  FALSE, TRUE),
  ('GATE_LOCKED',       'Gate locked',                  FALSE, TRUE,  TRUE),
  ('FIELD_IMPASSABLE',  'Field impassable',             FALSE, TRUE,  TRUE),
  ('POINT_UNDERWATER',  'Point underwater',             FALSE, TRUE,  TRUE),
  ('OTHER_SKIPPED',     'Other -- not sampled',         TRUE,  FALSE, TRUE)
WHERE NOT EXISTS (SELECT 1 FROM REF.DEVIATION_REASON);

-- 8d. Defect codes. The v02 addendum already seeds the three import-related
--     codes; these are the core server-rule and device set it assumes exists.
INSERT INTO REF.DEFECT_CODE
  (DEFECT_CODE, DISPLAY_LABEL, DEFAULT_SEVERITY, RAISED_BY, RULE_DESCRIPTION)
SELECT * FROM VALUES
  ('BARCODE_DUPLICATE',     'Duplicate barcode',           'blocking', 'server_rule', 'Same lab_id + barcode already bound to another bag.'),
  ('BARCODE_UNREAD',        'Barcode not scanned',         'review',   'device',      'Entered manually or not captured. Never normalised in place.'),
  ('MISSING_REQUIRED_MEDIA','Missing required photo',      'blocking', 'server_rule', 'A required media role from the project spec has no in-app-camera photo.'),
  ('NO_GPS_FIX',            'No GPS fix',                  'blocking', 'device',      'Sample captured with no satellite fix.'),
  ('GPS_ACCURACY_EXCEEDED', 'GPS accuracy exceeded',       'review',   'server_rule', 'Accuracy worse than GPS_ACCURACY_REQUIRED_M in the project spec.'),
  ('POINT_OUTSIDE_BOUNDARY','Point outside boundary',      'blocking', 'server_rule', 'Point-in-polygon matched no active boundary. Usually a boundary problem.'),
  ('PLAN_POINT_UNSAMPLED',  'Plan point never sampled',    'review',   'server_rule', 'Plan point neither sampled nor explicitly skipped at plan close.'),
  ('DEPTH_SHORTFALL',       'Depth below spec',            'review',   'device',      'Recorded depth short of the project spec interval.'),
  ('OFFSET_WITHOUT_REASON', 'Moved without a reason',      'blocking', 'server_rule', 'Offset beyond MAX_PLAN_OFFSET_M_BLOCK with no deviation reason.'),
  ('CLOCK_DRIFT_SUSPECTED', 'Device clock drift',          'review',   'server_rule', 'Device and server timestamps disagree beyond tolerance for the recorded uptime.'),
  ('LATE_SYNC',             'Synced late',                 'advisory', 'server_rule', 'Record reached the server well after capture. Operational signal, not a data fault.'),
  ('EXIF_POSITION_MISMATCH','Photo position disagrees',    'review',   'server_rule', 'Photo EXIF fix disagrees with the app fix beyond threshold. Two sources disagreeing is a finding.'),
  ('MEDIA_GALLERY_SOURCED', 'Gallery photo on required role','review', 'server_rule', 'A gallery photo satisfied a required role. The app should prevent this; the rule catches when it did not.'),
  ('MANUAL_POSITION',       'Position entered manually',   'review',   'device',      'Position from a dropped map pin rather than a satellite fix.')
WHERE NOT EXISTS (SELECT 1 FROM REF.DEFECT_CODE WHERE DEFECT_CODE = 'BARCODE_DUPLICATE');

-- 8e. Which defects reach the field next morning, per addendum 4.2. Everything
--     else stays in the office -- a crew cannot act on clock drift or an EXIF
--     mismatch, and pushing those down trains people to ignore the list.
INSERT INTO REF.DEFECT_FIELD_VISIBILITY
  (DEFECT_CODE, VISIBLE_TO_FIELD, FIELD_GUIDANCE)
SELECT * FROM VALUES
  ('BARCODE_DUPLICATE',     TRUE,  'Two bags share a barcode. Re-scan both if you are still nearby.'),
  ('BARCODE_UNREAD',        TRUE,  'Barcode was not readable. Photograph the label again if you can reach the point.'),
  ('MISSING_REQUIRED_MEDIA',TRUE,  'A required photo is missing. Revisit and capture it with the in-app camera.'),
  ('NO_GPS_FIX',            TRUE,  'This sample has no position. Revisit and re-capture.'),
  ('GPS_ACCURACY_EXCEEDED', TRUE,  'Position was too imprecise. Revisit under open sky if practical.'),
  ('POINT_OUTSIDE_BOUNDARY',TRUE,  'This point fell outside its field. Check you were at the right one.'),
  ('PLAN_POINT_UNSAMPLED',  TRUE,  'A planned point was never sampled or skipped. Sample it or record a skip reason.'),
  ('DEPTH_SHORTFALL',       TRUE,  'Recorded depth is short of the protocol. Re-drill if the point is reachable.'),
  ('OFFSET_WITHOUT_REASON', TRUE,  'This sample moved from its planned point with no reason recorded.'),
  ('CLOCK_DRIFT_SUSPECTED', FALSE, NULL),
  ('LATE_SYNC',             FALSE, NULL),
  ('EXIF_POSITION_MISMATCH',FALSE, NULL),
  ('MEDIA_GALLERY_SOURCED', FALSE, NULL),
  ('MANUAL_POSITION',       FALSE, NULL)
WHERE NOT EXISTS (SELECT 1 FROM REF.DEFECT_FIELD_VISIBILITY);

-- 8f. The lab. BARCODE_SYMBOLOGY stays NULL by design until Agidata confirms
--     it -- pre-work item 1. Nothing depends on the answer; the design is
--     symbology-agnostic. BARCODE_REUSED drives the lab-join date window.
INSERT INTO REF.LAB (LAB_ID, LAB_NAME, BARCODE_SYMBOLOGY, BARCODE_PATTERN, BARCODE_REUSED)
SELECT 'LAB_TBD', 'Lab pending confirmation', NULL, NULL, NULL
WHERE NOT EXISTS (SELECT 1 FROM REF.LAB WHERE LAB_ID = 'LAB_TBD');


-- ============================================================================
-- 9. VERIFICATION -- run all of it, read all of it
-- ============================================================================

-- 9a. Every object the DDL should have created.
SELECT TABLE_SCHEMA, TABLE_TYPE, COUNT(*) AS objects
  FROM VCH_SAMPLING.INFORMATION_SCHEMA.TABLES
 GROUP BY TABLE_SCHEMA, TABLE_TYPE
 ORDER BY TABLE_SCHEMA, TABLE_TYPE;

-- 9b. The v02 ALTERs landed. Expect 6 rows.
SELECT TABLE_NAME, COLUMN_NAME
  FROM VCH_SAMPLING.INFORMATION_SCHEMA.COLUMNS
 WHERE (TABLE_NAME = 'MEDIA'         AND COLUMN_NAME IN ('CAPTURE_SOURCE','DEVICE_ID','EXIF_GPS_PRESENT'))
    OR (TABLE_NAME = 'DEVICE'        AND COLUMN_NAME IN ('DEVICE_MODEL','MANUFACTURER','USER_AGENT_RAW'))
 ORDER BY TABLE_NAME, COLUMN_NAME;

-- 9c. Every view compiles. Any that depends on a bad Section 7 assumption
--     fails here, which is the cheapest place for it to fail.
SELECT 'V_SAMPLE_PLAN_OFFSET'  AS v, COUNT(*) FROM CURATED.V_SAMPLE_PLAN_OFFSET  UNION ALL
SELECT 'V_SAMPLE_REVIEW_QUEUE',      COUNT(*) FROM CURATED.V_SAMPLE_REVIEW_QUEUE UNION ALL
SELECT 'V_PLAN_COMPLETION',          COUNT(*) FROM CURATED.V_PLAN_COMPLETION     UNION ALL
SELECT 'V_BAG_LAB_MATCH',            COUNT(*) FROM CURATED.V_BAG_LAB_MATCH       UNION ALL
SELECT 'V_IMPORT_PREVIEW',           COUNT(*) FROM CURATED.V_IMPORT_PREVIEW      UNION ALL
SELECT 'V_FIELD_DEFECT_FEED',        COUNT(*) FROM CURATED.V_FIELD_DEFECT_FEED   UNION ALL
SELECT 'V_POINT_PROVENANCE',         COUNT(*) FROM CURATED.V_POINT_PROVENANCE;

-- 9d. Reference data is present. Zero anywhere means the capture screen has
--     nothing to render.
SELECT 'PROJECT_SAMPLING_SPEC'   AS t, COUNT(*) FROM REF.PROJECT_SAMPLING_SPEC   UNION ALL
SELECT 'CONDITION_CODE',               COUNT(*) FROM REF.CONDITION_CODE          UNION ALL
SELECT 'DEVIATION_REASON',             COUNT(*) FROM REF.DEVIATION_REASON        UNION ALL
SELECT 'DEFECT_CODE',                  COUNT(*) FROM REF.DEFECT_CODE             UNION ALL
SELECT 'DEFECT_FIELD_VISIBILITY',      COUNT(*) FROM REF.DEFECT_FIELD_VISIBILITY UNION ALL
SELECT 'LAB',                          COUNT(*) FROM REF.LAB;

-- 9e. Every defect code has a field-visibility decision. Should return zero.
SELECT c.DEFECT_CODE AS missing_visibility_decision
  FROM REF.DEFECT_CODE c
  LEFT JOIN REF.DEFECT_FIELD_VISIBILITY v ON v.DEFECT_CODE = c.DEFECT_CODE
 WHERE v.DEFECT_CODE IS NULL;

-- 9f. The grant surface, as the app role actually sees it. Confirm no DELETE.
SHOW GRANTS TO ROLE SAMPLING_APP_RW;

-- 9g. END TO END -- the only test that proves pre-work is genuinely done.
--     Run from a shell, not a worksheet. Build the JWT with:
--       iss = <ACCOUNT_IDENTIFIER>.<USER>.SHA256:<RSA_PUBLIC_KEY_FP from 5>
--       sub = <ACCOUNT_IDENTIFIER>.<USER>
--     Both uppercase. Max lifetime 1 hour. Verify the exact claim format
--     against Snowflake's current SQL API docs -- it has changed before.
--
--       curl -X POST \
--         "https://<account>.snowflakecomputing.com/api/v2/statements" \
--         -H "Authorization: Bearer $JWT" \
--         -H "X-Snowflake-Authorization-Token-Type: KEYPAIR_JWT" \
--         -H "Content-Type: application/json" \
--         -d '{"statement":"SELECT COUNT(*) FROM REF.DEFECT_CODE",
--              "warehouse":"WH_SAMPLING_XS",
--              "database":"VCH_SAMPLING",
--              "schema":"REF",
--              "role":"SAMPLING_APP_RW"}'
--
--     A row count back means the whole chain works: network policy, key-pair
--     auth, role, warehouse, and grants. Anything less is not done.


-- ============================================================================
-- 10. TEARDOWN -- the whole point of a separate database
--
-- Commented out deliberately. Uncomment only to abandon the pilot.
-- Order matters: user before role, policies before user.
-- ============================================================================

-- USE ROLE ACCOUNTADMIN;
-- ALTER USER SVC_SAMPLING_APP UNSET NETWORK_POLICY;
-- DROP USER IF EXISTS SVC_SAMPLING_APP;
-- DROP NETWORK POLICY IF EXISTS NP_SAMPLING_SERVICE;
-- DROP NETWORK POLICY IF EXISTS NP_SAMPLING_HUMAN;
-- DROP DATABASE IF EXISTS VCH_SAMPLING;          -- recoverable within Time Travel
-- DROP WAREHOUSE IF EXISTS WH_SAMPLING_XS;
-- DROP RESOURCE MONITOR IF EXISTS RM_SAMPLING;
-- USE ROLE SECURITYADMIN;
-- DROP ROLE IF EXISTS SAMPLING_APP_RW;
-- Nothing above touches VCH_GEO. The Section 7 grants to SAMPLING_APP_RW
-- disappear with the role.
