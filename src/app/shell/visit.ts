/**
 * B7 wiring — resolves which `field_visit` a capture belongs to.
 *
 * **Read-only.** `CaptureSession.save()` (`@app/capture/index.js`,
 * `capture-integrity`'s wave-2 `save.ts`) writes the `field_visit` row itself,
 * transactionally, alongside the sample it belongs to — passing a freshly
 * generated `FieldVisitPayload` through `CaptureSessionOptions.visit` is what
 * makes that possible even though no visit row exists yet. This module's only
 * job is deciding *which* visit id to use: reuse the boundary's current
 * `in_progress` visit if one exists, otherwise mint a new id and payload for
 * the session to persist.
 *
 * "One active visit per boundary" is a simplification named here rather than
 * hidden: v02 doesn't specify how a visit's lifecycle maps to a UI session,
 * and reusing a single `status = 'in_progress'` row per boundary is the
 * smallest thing that lets multiple captures in the same boundary share one
 * parent without inventing visit start/end UI this wave does not own.
 */

import { uuidv7 } from 'uuidv7';
import type { SqlDatabase } from '@shared/db/types.js';
import type { FieldVisitPayload } from '@shared/contract/entities.js';

export interface ResolvedVisit {
  visitId: string;
  /** Non-null only when this visit does not exist on the device yet — pass
   *  straight through to `CaptureSessionOptions.visit` so `session.save()`
   *  persists it. `null` means the row is already there. */
  visit: FieldVisitPayload | null;
}

export async function resolveVisitForBoundary(
  db: SqlDatabase,
  params: {
    boundaryId: string;
    planId: string | null;
    specId: string | null;
    crewOrgId: string | null;
    deviceId: string | null;
    nowIso: string;
  },
): Promise<ResolvedVisit> {
  const existing = await db.all<{ visit_id: string }>(
    `SELECT visit_id FROM field_visit WHERE boundary_id = ? AND status = 'in_progress'
      ORDER BY started_ts DESC LIMIT 1`,
    [params.boundaryId],
  );
  const found = existing[0];
  if (found) {
    return { visitId: found.visit_id, visit: null };
  }

  const visitId = uuidv7();
  const visit: FieldVisitPayload = {
    visit_id: visitId,
    boundary_id: params.boundaryId,
    plan_id: params.planId,
    spec_id: params.specId,
    crew_org_id: params.crewOrgId,
    sampler_person_id: null,
    device_id: params.deviceId,
    access_contact_person_id: null,
    visit_date: params.nowIso.slice(0, 10),
    started_ts: params.nowIso,
    ended_ts: null,
    status: 'in_progress',
    abandon_reason_code: null,
    visit_note: null,
    app_version: null,
  };
  return { visitId, visit };
}
