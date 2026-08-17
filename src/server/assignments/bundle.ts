/**
 * A2 — `GET /v1/assignments/bundle`. Contract §2.
 *
 * Replace-never-patch: every array in the response replaces the device's
 * local table wholesale (`src/shared/db/schema.ts` `clearBundleTables` is the
 * device-side half of this contract). `etag` is a hash of the assembled
 * bundle; a client that already has it gets a 304 and no body.
 *
 * **Open schema question, isolated here on purpose.** No table in this
 * repo's DDL maps `crew_org_id` to a set of boundaries — plan v02 §13 open
 * question 5 names exactly this ("`crew_org_id` — CRM `OPERATION` or its own
 * table. Decide with the Phase 1 entity model."). Scoping here falls back to
 * "every active boundary with a released plan for the period", which is
 * everything a v1 pilot with one or two crews actually needs, and is
 * `BOUNDARY_ASSIGNMENT`-shaped so a real assignment table is a one-line swap
 * of `boundaryIdsForCrew` below when that table exists. Flagged in
 * `integration/requests-a.md`.
 */
import { createHash } from 'node:crypto';
import type {
  AssignmentBundle,
  AssignedBoundary,
  BundlePlanPoint,
  ProjectSamplingSpec,
  RefConditionCode,
  RefDefectCode,
  RefDeviationReason,
  RefLab,
  AccessContact,
  TilePackRef,
} from '../../shared/contract/bundle.js';
import type { SqlCapabilities, SqlClient } from '../../shared/db/port.js';
import { asObjects, SNOWFLAKE_CAPABILITIES } from '../../shared/db/port.js';
import { uuidv7 } from 'uuidv7';

/**
 * Defensive fallback to full (Snowflake) capability when a client does not
 * actually carry `.capabilities` at runtime — same helper, same reason, as
 * `src/ingest/commit/index.ts` / `src/ingest/retire/index.ts`:
 * `tests/support/fake-snowflake.ts` (shared, unowned) predates the SQL port
 * and its `asClient()` cast bypasses the structural check.
 */
function capsOf(client: SqlClient): SqlCapabilities {
  return client.capabilities ?? SNOWFLAKE_CAPABILITIES;
}

export interface BundleAssemblyInput {
  crewOrgId: string;
  period: string;
  serverTimeIso: string;
  /** Configurable per plan §5: 14 days at launch, may tune to 10. */
  expiryDays?: number;
  specs: ProjectSamplingSpec[];
  refConditionCode: RefConditionCode[];
  refDeviationReason: RefDeviationReason[];
  refDefectCode: RefDefectCode[];
  refLab: RefLab[];
  boundaries: AssignedBoundary[];
  planPoints: BundlePlanPoint[];
  accessContacts: AccessContact[];
  tilePack: TilePackRef | null;
}

const DEFAULT_EXPIRY_DAYS = 14;

export function assembleBundle(input: BundleAssemblyInput): AssignmentBundle {
  const expiryDays = input.expiryDays ?? DEFAULT_EXPIRY_DAYS;
  const expiresTs = new Date(
    Date.parse(input.serverTimeIso) + expiryDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const bundle: Omit<AssignmentBundle, 'bundle_id' | 'etag'> = {
    schema_version: '1.0',
    server_time: input.serverTimeIso,
    expires_ts: expiresTs,
    specs: input.specs,
    ref_condition_code: input.refConditionCode,
    ref_deviation_reason: input.refDeviationReason,
    ref_defect_code: input.refDefectCode,
    ref_lab: input.refLab,
    boundaries: input.boundaries,
    plan_points: input.planPoints,
    access_contacts: input.accessContacts,
    tile_pack: input.tilePack,
  };

  // The etag covers everything EXCEPT server_time and expires_ts -- both
  // change on every request even when the underlying assignment set has not,
  // and an etag that changes every request defeats If-None-Match entirely.
  const { server_time: _st, expires_ts: _et, ...stable } = bundle;
  const etag = `sha256:${createHash('sha256').update(JSON.stringify(stable)).digest('hex')}`;

  return { bundle_id: uuidv7(), etag, ...bundle };
}

export interface LiveBundleDeps {
  /** Field name unchanged across the port — `SnowflakeClient` and the Postgres
   *  adapter both satisfy `SqlClient` structurally. */
  snowflake: SqlClient;
}

/**
 * Live assembly. See the module comment: `boundaryIdsForCrew` is the one
 * function to replace once a real crew→boundary assignment table exists.
 */
export async function assembleLiveBundle(
  input: { crewOrgId: string; period: string; expiryDays?: number },
  deps: LiveBundleDeps,
): Promise<AssignmentBundle> {
  const sf = deps.snowflake;
  const serverTimeIso = new Date().toISOString();

  const boundaryIds = await boundaryIdsForCrew(sf, input.period);

  // `CURRENT_DATE()` (Snowflake) vs `CURRENT_DATE` (Postgres rejects the
  // parens) -- same dialect gap as `CURRENT_TIMESTAMP()` elsewhere in the
  // codebase (`src/ingest/retire/index.ts`), gated on the same capability
  // flag rather than a new one.
  const currentDate = capsOf(sf).mergeInto ? 'CURRENT_DATE()' : 'CURRENT_DATE';

  const [specs, refConditionCode, refDeviationReason, refDefectCode, refLab, boundaries, planPoints, accessContacts] =
    await Promise.all([
      asObjects<ProjectSamplingSpec>(
        await sf.execute(
          `SELECT SPEC_ID AS spec_id, PROJECT_ID AS project_id, PROTOCOL_VERSION AS protocol_version,
                  PERIOD_CODE AS period_code, DEPTH_TOP_CM AS depth_top_cm, DEPTH_BOTTOM_CM AS depth_bottom_cm,
                  DEPTH_INCREMENTS_JSON AS depth_increments_json, OVERDRILL_CM AS overdrill_cm,
                  CORES_PER_COMPOSITE_MIN AS cores_per_composite_min, CORES_PER_COMPOSITE_MAX AS cores_per_composite_max,
                  COMPOSITE_RADIUS_M AS composite_radius_m, BD_CORE_REQUIRED AS bd_core_required,
                  BAG_SCHEME AS bag_scheme, REQUIRED_MEDIA_ROLES AS required_media_roles,
                  GPS_ACCURACY_REQUIRED_M AS gps_accuracy_required_m, MIN_GPS_FIX_COUNT AS min_gps_fix_count,
                  MAX_PLAN_OFFSET_M_WARN AS max_plan_offset_m_warn, MAX_PLAN_OFFSET_M_BLOCK AS max_plan_offset_m_block,
                  DEFAULT_LAB_ID AS default_lab_id
             FROM REF.PROJECT_SAMPLING_SPEC
            WHERE PERIOD_CODE = ? AND (EFFECTIVE_END IS NULL OR EFFECTIVE_END >= ${currentDate})`,
          { binds: [input.period] },
        ),
      ),
      asObjects<RefConditionCode>(
        await sf.execute(
          `SELECT CONDITION_CODE AS condition_code, CODE_SET_VERSION AS code_set_version,
                  CONDITION_GROUP AS condition_group, DISPLAY_LABEL AS display_label,
                  VALUE_TYPE AS value_type, VALUE_OPTIONS AS value_options, SORT_ORDER AS sort_order
             FROM REF.CONDITION_CODE WHERE IS_ACTIVE = TRUE`,
        ),
      ),
      asObjects<RefDeviationReason>(
        await sf.execute(
          `SELECT DEVIATION_REASON_CODE AS deviation_reason_code, DISPLAY_LABEL AS display_label,
                  REQUIRES_NOTE AS requires_note, REQUIRES_PHOTO AS requires_photo,
                  IS_SKIP_REASON AS is_skip_reason
             FROM REF.DEVIATION_REASON WHERE IS_ACTIVE = TRUE`,
        ),
      ),
      asObjects<RefDefectCode>(
        await sf.execute(
          `SELECT DEFECT_CODE AS defect_code, DISPLAY_LABEL AS display_label,
                  DEFAULT_SEVERITY AS default_severity, RAISED_BY AS raised_by
             FROM REF.DEFECT_CODE WHERE IS_ACTIVE = TRUE`,
        ),
      ),
      asObjects<RefLab>(
        await sf.execute(
          `SELECT LAB_ID AS lab_id, LAB_NAME AS lab_name, BARCODE_SYMBOLOGY AS barcode_symbology,
                  BARCODE_PATTERN AS barcode_pattern
             FROM REF.LAB WHERE IS_ACTIVE = TRUE`,
        ),
      ),
      loadBoundaries(sf, boundaryIds),
      loadPlanPoints(sf, boundaryIds),
      loadAccessContacts(sf, boundaryIds),
    ]);

  return assembleBundle({
    crewOrgId: input.crewOrgId,
    period: input.period,
    serverTimeIso,
    expiryDays: input.expiryDays,
    specs,
    refConditionCode,
    refDeviationReason,
    refDefectCode,
    refLab,
    boundaries,
    planPoints,
    accessContacts,
    tilePack: null, // fetched separately by the client, contract §2
  });
}

/** See module comment -- the one guessed piece, isolated here. Plain ANSI SQL, no dialect gap. */
async function boundaryIdsForCrew(sf: SqlClient, period: string): Promise<string[]> {
  const rows = asObjects<{ boundary_id: string }>(
    await sf.execute(
      `SELECT DISTINCT BOUNDARY_ID FROM CURATED.SAMPLE_PLAN
        WHERE PERIOD_CODE = ? AND STATUS = 'released'`,
      { binds: [period] },
    ),
  );
  return rows.map((r) => r.boundary_id);
}

/**
 * Dialect gap gated on `capabilities.geospatial`, per contract -- not a new
 * flag. On Snowflake, `V_BOUNDARY_ENTITY.GEOG` is real geography and this
 * derives GeoJSON/bbox/centroid with `ST_*`. On Postgres there is no PostGIS,
 * but nothing here is silently missing: `CURATED.BOUNDARY_CACHE` (the table
 * `V_BOUNDARY_ENTITY` is a view over, on that backend --
 * `postgres_sampling_v01.sql` §3/§8) stores GeoJSON and the bbox/centroid
 * PRECOMPUTED, specifically so this read needs no geospatial engine. The two
 * branches project to the *same* column aliases so the row-mapping below is
 * shared and cannot drift between backends.
 */
async function loadBoundaries(sf: SqlClient, boundaryIds: string[]): Promise<AssignedBoundary[]> {
  if (boundaryIds.length === 0) return [];
  const placeholders = boundaryIds.map(() => '?').join(',');
  const sql = capsOf(sf).geospatial
    ? `SELECT b.BOUNDARY_ID AS boundary_id, b.PROPERTY_ID AS property_id,
              b.PROPERTY_NAME AS property_name, NULL AS operation_name,
              ST_ASGEOJSON(b.GEOG) AS geojson_raw,
              ST_XMIN(b.GEOG) AS west, ST_YMIN(b.GEOG) AS south,
              ST_XMAX(b.GEOG) AS east, ST_YMAX(b.GEOG) AS north,
              ST_Y(ST_CENTROID(b.GEOG)) AS centroid_lat, ST_X(ST_CENTROID(b.GEOG)) AS centroid_lon,
              b.GEOM_ACRES AS geom_acres, b.TRS_CANONICAL AS trs_canonical,
              NULL AS access_note, p.PLAN_ID AS plan_id, p.SPEC_ID AS spec_id,
              p.PERIOD_CODE AS period_code, NULL AS sort_order
         FROM CURATED.V_BOUNDARY_ENTITY b
         JOIN CURATED.SAMPLE_PLAN p ON p.BOUNDARY_ID = b.BOUNDARY_ID AND p.STATUS = 'released'
        WHERE b.BOUNDARY_ID IN (${placeholders})`
    : `SELECT b.BOUNDARY_ID AS boundary_id, b.PROPERTY_ID AS property_id,
              b.PROPERTY_NAME AS property_name, NULL AS operation_name,
              b.GEOJSON AS geojson_raw,
              b.BBOX_WEST AS west, b.BBOX_SOUTH AS south,
              b.BBOX_EAST AS east, b.BBOX_NORTH AS north,
              b.CENTROID_LAT AS centroid_lat, b.CENTROID_LON AS centroid_lon,
              b.GEOM_ACRES AS geom_acres, b.TRS_CANONICAL AS trs_canonical,
              NULL AS access_note, p.PLAN_ID AS plan_id, p.SPEC_ID AS spec_id,
              p.PERIOD_CODE AS period_code, NULL AS sort_order
         FROM CURATED.V_BOUNDARY_ENTITY b
         JOIN CURATED.SAMPLE_PLAN p ON p.BOUNDARY_ID = b.BOUNDARY_ID AND p.STATUS = 'released'
        WHERE b.BOUNDARY_ID IN (${placeholders})`;
  const rows = asObjects<Record<string, string | null>>(
    await sf.execute(sql, { binds: boundaryIds }),
  );
  return rows.map((r) => ({
    boundary_id: String(r.boundary_id),
    property_id: r.property_id ?? null,
    property_name: r.property_name ?? null,
    operation_name: r.operation_name ?? null,
    geojson: JSON.parse(r.geojson_raw ?? 'null'),
    bbox: r.west ? [Number(r.west), Number(r.south), Number(r.east), Number(r.north)] : null,
    centroid_lat: r.centroid_lat ? Number(r.centroid_lat) : null,
    centroid_lon: r.centroid_lon ? Number(r.centroid_lon) : null,
    geom_acres: r.geom_acres ? Number(r.geom_acres) : null,
    trs_canonical: r.trs_canonical ?? null,
    access_note: r.access_note ?? null,
    plan_id: r.plan_id ?? null,
    spec_id: r.spec_id ?? null,
    period_code: r.period_code ?? null,
    sort_order: r.sort_order ? Number(r.sort_order) : null,
  }));
}

async function loadPlanPoints(sf: SqlClient, boundaryIds: string[]): Promise<BundlePlanPoint[]> {
  if (boundaryIds.length === 0) return [];
  const rows = asObjects<Record<string, string | null>>(
    await sf.execute(
      `SELECT pp.PLAN_POINT_ID AS plan_point_id, pp.PLAN_ID AS plan_id, p.BOUNDARY_ID AS boundary_id,
              pp.PLAN_POINT_LABEL AS plan_point_label, pp.PLANNED_LAT AS planned_lat,
              pp.PLANNED_LON AS planned_lon, pp.STRATA_LABEL AS strata_label,
              pp.ELEVATION_CLASS AS elevation_class, pp.PRIOR_SAMPLE_UID AS prior_sample_uid,
              NULL AS prior_lat, NULL AS prior_lon, pp.SEQUENCE_NO AS sequence_no,
              pp.ACCESS_NOTE AS access_note
         FROM CURATED.SAMPLE_PLAN_POINT pp
         JOIN CURATED.SAMPLE_PLAN p ON p.PLAN_ID = pp.PLAN_ID AND p.STATUS = 'released'
        WHERE p.BOUNDARY_ID IN (${boundaryIds.map(() => '?').join(',')})`,
      { binds: boundaryIds },
    ),
  );
  return rows.map((r) => ({
    plan_point_id: String(r.plan_point_id),
    plan_id: r.plan_id ?? null,
    boundary_id: String(r.boundary_id),
    plan_point_label: r.plan_point_label ?? null,
    planned_lat: Number(r.planned_lat),
    planned_lon: Number(r.planned_lon),
    strata_label: r.strata_label ?? null,
    elevation_class: r.elevation_class ?? null,
    prior_sample_uid: r.prior_sample_uid ?? null,
    prior_lat: null,
    prior_lon: null,
    sequence_no: r.sequence_no ? Number(r.sequence_no) : null,
    access_note: r.access_note ?? null,
  }));
}

/**
 * **Guessed table**, same footing as `V_BOUNDARY_ENTITY` — no `ACCESS_CONTACT`
 * table exists in either DDL file (confirmed absent from
 * `postgres_sampling_v01.sql` too — schema-steward's report §7 lists it as
 * out of scope on purpose). Access contacts are the entire BYOD
 * data-exposure story (contract §2), so returning an empty list rather than
 * guessing wrong is the safer failure mode until the table is confirmed;
 * this still attempts the query so a correct guess needs no code change.
 *
 * The failure is swallowed to `[]` deliberately (agent file non-negotiable),
 * but logged rather than silent — "no access contacts" and "the query
 * errored" must not read the same to whoever operates this.
 */
async function loadAccessContacts(sf: SqlClient, boundaryIds: string[]): Promise<AccessContact[]> {
  if (boundaryIds.length === 0) return [];
  try {
    const rows = asObjects<Record<string, string | null>>(
      await sf.execute(
        `SELECT CONTACT_ID AS contact_id, BOUNDARY_ID AS boundary_id, PERSON_ID AS person_id,
                DISPLAY_NAME AS display_name, ROLE_LABEL AS role_label, PHONE AS phone,
                IS_PRIMARY AS is_primary
           FROM CURATED.ACCESS_CONTACT
          WHERE BOUNDARY_ID IN (${boundaryIds.map(() => '?').join(',')})`,
        { binds: boundaryIds },
      ),
    );
    return rows.map((r) => ({
      contact_id: String(r.contact_id),
      boundary_id: String(r.boundary_id),
      person_id: r.person_id ?? null,
      display_name: r.display_name ?? null,
      role_label: (r.role_label ?? null) as AccessContact['role_label'],
      phone: r.phone ?? null,
      is_primary: r.is_primary === 'true' || r.is_primary === '1',
    }));
  } catch (err) {
    // Deliberately still returns []  (task: "keep the failure visible in a
    // log rather than making it quieter") -- empty access_contacts is the
    // entire BYOD data-exposure story shipping blank, so an operator needs a
    // way to tell "genuinely none configured" from "the query broke" without
    // reading this source file.
    console.error(
      'assignments/bundle: loadAccessContacts query against CURATED.ACCESS_CONTACT failed ' +
        '(guessed table name -- see integration/requests-a.md); serving access_contacts: [] ' +
        'for this bundle rather than failing the whole request.',
      err,
    );
    return [];
  }
}
