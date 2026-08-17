-- ============================================================================
-- VCH Sampling App -- Snowflake v03: entity-name compatibility
-- 2026-08-16
--
-- Deploy AFTER snowflake_sampling_v01.sql and snowflake_v02_addendum.sql.
-- CREATE OR REPLACE only -- no data is touched.
--
-- WHY THIS FILE EXISTS
--
-- A12 in the concurrent build plan asks for the CURATED.BOUNDARY / PROPERTY /
-- LAB_RESULT references in V_IMPORT_PREVIEW to be corrected against the live
-- FACT_BORDER naming. Those references assume the Phase 1 entity model. The
-- live names cannot be confirmed from the repository -- that needs a session
-- against VCH_GEO, which needs the service user that is pre-work item 5.
--
-- Guessing a table name here would be worse than leaving it: a wrong guess
-- deploys, fails at query time, and looks like a code bug rather than a naming
-- question. So this file does the thing that IS decidable today -- it collapses
-- the entity-model dependency from three scattered references into ONE view,
-- so the correction is a single edit in a known place rather than an audit of
-- every consumer.
--
--   Before: V_IMPORT_PREVIEW joins CURATED.BOUNDARY and CURATED.PROPERTY
--           directly; V_BAG_LAB_MATCH joins CURATED.LAB_RESULT directly.
--   After:  both go through V_BOUNDARY_ENTITY / V_LAB_RESULT_ENTITY, and the
--           entity-model question lives in exactly two CREATE VIEW statements.
--
-- WHEN THE LIVE NAMES ARE CONFIRMED: edit the two views below and nothing else.
-- If the Phase 1 names are already live, they are correct as written and this
-- file is a no-op with a comment.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- The boundary + property projection every sampling object needs.
--
-- If the live model is still legacy FACT_BORDER, replace the body with the
-- equivalent projection over it -- the column list is the contract, and it is
-- deliberately narrow so that mapping stays mechanical.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW CURATED.V_BOUNDARY_ENTITY AS
SELECT b.BOUNDARY_ID,
       b.PROPERTY_ID,
       p.PROPERTY_NAME,
       b.GEOM_ACRES,
       b.GEOG,
       b.TRS_CANONICAL,
       b.STATUS
  FROM CURATED.BOUNDARY  b
  LEFT JOIN CURATED.PROPERTY p ON p.PROPERTY_ID = b.PROPERTY_ID;

-- ---------------------------------------------------------------------------
-- The lab-result projection the bag join needs. Same reasoning.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW CURATED.V_LAB_RESULT_ENTITY AS
SELECT lr.LAB_RESULT_ID,
       lr.LAB_ID,
       lr.LAB_BARCODE,
       lr.RECEIVED_DATE,
       lr.TOC_PCT,
       lr.TC_PCT,
       lr.CCE_PCT,
       lr.BULK_DENSITY_G_CM3,
       lr.OM_PCT
  FROM CURATED.LAB_RESULT lr;

-- ---------------------------------------------------------------------------
-- V_IMPORT_PREVIEW, rebuilt over the compatibility view.
-- Column list is unchanged -- the ingest tool sees exactly what it saw before.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- V_BAG_LAB_MATCH, rebuilt over the compatibility view.
-- The date window still guards cross-season barcode reuse; set it from
-- REF.LAB.BARCODE_REUSED once Agidata confirms their policy (pre-work item 1).
-- ---------------------------------------------------------------------------
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
  LEFT JOIN CURATED.V_LAB_RESULT_ENTITY lr
         ON lr.LAB_ID = bag.LAB_ID
        AND lr.LAB_BARCODE = bag.BARCODE_NORM
        AND lr.RECEIVED_DATE BETWEEN bag.BARCODE_SCANNED_TS::DATE
                                 AND DATEADD(DAY, 120, bag.BARCODE_SCANNED_TS::DATE)
 WHERE bag.VOID_FLAG = FALSE;

-- ---------------------------------------------------------------------------
-- Field-visibility seed. Addendum §4.2 names which codes reach a crew and
-- which stay in the office. The table shipped empty in v02, which means
-- COALESCE(..., FALSE) currently hides every defect from the field -- correct
-- as a default, wrong as a permanent state.
--
-- Guidance text is written for a phone held in wind, not for a queue.
-- ---------------------------------------------------------------------------
INSERT INTO REF.DEFECT_FIELD_VISIBILITY (DEFECT_CODE, VISIBLE_TO_FIELD, FIELD_GUIDANCE)
SELECT column1, column2, column3
  FROM VALUES
    ('BARCODE_DUPLICATE',      TRUE,  'This bag''s barcode is on another bag. Check the label and re-scan.'),
    ('BARCODE_UNREAD',         TRUE,  'The barcode did not read. Type it in or photograph the label.'),
    ('MISSING_REQUIRED_MEDIA', TRUE,  'A required photo is missing for this point.'),
    ('NO_GPS_FIX',             TRUE,  'No satellite fix was recorded here. Re-visit and capture a fix.'),
    ('GPS_ACCURACY_EXCEEDED',  TRUE,  'The fix was weaker than the protocol asks for.'),
    ('POINT_OUTSIDE_BOUNDARY', TRUE,  'This point fell outside every field boundary. Usually a boundary problem -- flag it, do not re-drill without checking.'),
    ('PLAN_POINT_UNSAMPLED',   TRUE,  'This planned point has no sample yet.'),
    ('DEPTH_SHORTFALL',        TRUE,  'Recorded depth is short of the protocol. Note the refusal reason.'),
    -- Office-only. A crew cannot act on any of these, and pushing them down
    -- trains people to ignore the list.
    ('CLOCK_DRIFT_SUSPECTED',  FALSE, NULL),
    ('LATE_SYNC',              FALSE, NULL),
    ('EXIF_POSITION_MISMATCH', FALSE, NULL),
    ('MEDIA_GALLERY_SOURCED',  FALSE, NULL),
    ('MANUAL_POSITION',        FALSE, NULL),
    ('IMPORT_OPERATION_UNRESOLVED', FALSE, NULL),
    ('IMPORT_CONTACT_UNRESOLVED',   FALSE, NULL)
 WHERE column1 NOT IN (SELECT DEFECT_CODE FROM REF.DEFECT_FIELD_VISIBILITY);
