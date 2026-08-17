/**
 * B4/B5 — applies a fetched `AssignmentBundle` to the device database.
 *
 * **Replace, never patch** (contract §2, `src/shared/db/schema.ts`'s
 * `clearBundleTables`): every reference/plan-point table is wiped and
 * rewritten wholesale. `local_status` on `sample_plan_point` is a
 * device-local annotation bolted onto a bundle-replaced table, so a re-apply
 * would silently erase "sampled"/"skipped" markers set since the last
 * download — this module is deliberately called once, guarded by
 * `bundle_manifest` already holding a row (see `TodayScreen`), not on every
 * screen visit. Preserving `local_status` across a genuine re-sync (a second
 * bundle fetch after the first) is real future work, named rather than
 * solved — flagged in the wave report.
 */

import { uuidv7 } from 'uuidv7';
import type { SqlDatabase, SqlValue } from '../../../shared/db/types.js';
import { clearBundleTables } from '../../../shared/db/schema.js';
import type { AssignmentBundle } from '../../../shared/contract/bundle.js';

/**
 * `SqlDatabase.run` (and the real `wa-sqlite`/`node:sqlite` drivers behind
 * it) bind `null` fine but throw on `undefined` — and a wire payload that
 * simply omits an optional key (JSON has no `undefined`) becomes exactly
 * that once cast through a TypeScript interface. One coercion point here
 * rather than an `?? null` on every one of the ~70 bound values below.
 */
function run(db: SqlDatabase, sql: string, params: (SqlValue | undefined)[]): Promise<void> {
  return db.run(sql, params.map((v) => (v === undefined ? null : v)) as SqlValue[]);
}

export async function applyBundleToDevice(
  db: SqlDatabase,
  bundle: AssignmentBundle,
  nowIso: string = new Date().toISOString(),
): Promise<void> {
  await clearBundleTables(db);

  for (const spec of bundle.specs) {
    await run(db,
      `INSERT INTO project_sampling_spec
         (spec_id, project_id, protocol_version, period_code, depth_top_cm, depth_bottom_cm,
          depth_increments_json, overdrill_cm, cores_per_composite_min, cores_per_composite_max,
          composite_radius_m, bd_core_required, bag_scheme, required_media_roles,
          gps_accuracy_required_m, min_gps_fix_count, max_plan_offset_m_warn, max_plan_offset_m_block,
          default_lab_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        spec.spec_id,
        spec.project_id,
        spec.protocol_version,
        spec.period_code,
        spec.depth_top_cm,
        spec.depth_bottom_cm,
        spec.depth_increments_json ? JSON.stringify(spec.depth_increments_json) : null,
        spec.overdrill_cm,
        spec.cores_per_composite_min,
        spec.cores_per_composite_max,
        spec.composite_radius_m,
        spec.bd_core_required ? 1 : 0,
        // Not in the F0.7 demo fixture (RawFixture omits it) — 'composite' is
        // the only bag role the local schema's own DEFAULT matches.
        spec.bag_scheme ?? 'composite',
        JSON.stringify(spec.required_media_roles ?? []),
        spec.gps_accuracy_required_m,
        spec.min_gps_fix_count,
        spec.max_plan_offset_m_warn,
        spec.max_plan_offset_m_block,
        spec.default_lab_id,
      ],
    );
  }

  for (const c of bundle.ref_condition_code) {
    await run(db,
      `INSERT INTO ref_condition_code
         (condition_code, code_set_version, condition_group, display_label, value_type, value_options, sort_order)
       VALUES (?,?,?,?,?,?,?)`,
      [
        c.condition_code,
        c.code_set_version,
        c.condition_group,
        c.display_label,
        c.value_type,
        c.value_options ? JSON.stringify(c.value_options) : null,
        c.sort_order,
      ],
    );
  }

  for (const d of bundle.ref_deviation_reason) {
    await run(db,
      `INSERT INTO ref_deviation_reason
         (deviation_reason_code, display_label, requires_note, requires_photo, is_skip_reason)
       VALUES (?,?,?,?,?)`,
      [d.deviation_reason_code, d.display_label, d.requires_note ? 1 : 0, d.requires_photo ? 1 : 0, d.is_skip_reason ? 1 : 0],
    );
  }

  for (const d of bundle.ref_defect_code) {
    await run(db,
      `INSERT INTO ref_defect_code (defect_code, display_label, default_severity, raised_by) VALUES (?,?,?,?)`,
      [d.defect_code, d.display_label, d.default_severity, d.raised_by],
    );
  }

  for (const l of bundle.ref_lab) {
    await run(db,
      `INSERT INTO ref_lab (lab_id, lab_name, barcode_symbology, barcode_pattern) VALUES (?,?,?,?)`,
      [l.lab_id, l.lab_name, l.barcode_symbology, l.barcode_pattern],
    );
  }

  for (const b of bundle.boundaries) {
    await run(db,
      `INSERT INTO assigned_boundary
         (boundary_id, property_id, property_name, operation_name, geojson, bbox_json, centroid_lat,
          centroid_lon, geom_acres, trs_canonical, access_note, plan_id, spec_id, period_code, sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        b.boundary_id,
        b.property_id,
        b.property_name,
        b.operation_name,
        JSON.stringify(b.geojson),
        b.bbox ? JSON.stringify(b.bbox) : null,
        b.centroid_lat,
        b.centroid_lon,
        b.geom_acres,
        b.trs_canonical,
        b.access_note,
        b.plan_id,
        b.spec_id,
        b.period_code,
        b.sort_order,
      ],
    );
  }

  for (const p of bundle.plan_points) {
    await run(db,
      `INSERT INTO sample_plan_point
         (plan_point_id, plan_id, boundary_id, plan_point_label, planned_lat, planned_lon, strata_label,
          elevation_class, prior_sample_uid, prior_lat, prior_lon, sequence_no, access_note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        p.plan_point_id,
        p.plan_id,
        p.boundary_id,
        p.plan_point_label,
        p.planned_lat,
        p.planned_lon,
        p.strata_label,
        p.elevation_class,
        p.prior_sample_uid,
        p.prior_lat,
        p.prior_lon,
        p.sequence_no,
        p.access_note,
      ],
    );
  }

  for (const c of bundle.access_contacts) {
    await run(db,
      `INSERT INTO access_contact (contact_id, boundary_id, person_id, display_name, role_label, phone, is_primary)
       VALUES (?,?,?,?,?,?,?)`,
      [c.contact_id, c.boundary_id, c.person_id, c.display_name, c.role_label, c.phone, c.is_primary ? 1 : 0],
    );
  }

  await run(db,
    `INSERT OR REPLACE INTO bundle_manifest
       (bundle_id, etag, schema_version, fetched_ts, expires_ts, boundary_count, plan_point_count,
        tile_pack_version, server_time_at_fetch)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      bundle.bundle_id || uuidv7(),
      bundle.etag,
      bundle.schema_version,
      nowIso,
      bundle.expires_ts,
      bundle.boundaries.length,
      bundle.plan_points.length,
      bundle.tile_pack?.version ?? null,
      bundle.server_time,
    ],
  );
}
