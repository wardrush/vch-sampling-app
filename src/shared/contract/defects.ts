/**
 * Defect down-sync. Addendum §4.2.
 *
 * **v1.5, not v1** — it depends on the analyst queue existing and on nightly
 * sync being real, and both are things the pilot establishes rather than
 * assumes. The types ship in v1 so the device schema does not migrate
 * mid-season.
 *
 * Only codes a crew can *act on* come down. Pushing `CLOCK_DRIFT_SUSPECTED` to
 * a phone is noise that trains people to ignore the list, which is worse than
 * not having one.
 */

import type { DefectSeverity, IsoTimestamp } from './common.js';

export interface DefectFeedRequest {
  crew_org_id: string;
  since?: IsoTimestamp;
}

export interface FieldDefect {
  defect_id: string;
  defect_code: string;
  severity: DefectSeverity | string | null;
  detected_ts: IsoTimestamp | null;
  sample_uid: string | null;
  plan_point_id: string | null;
  plan_point_label: string | null;
  boundary_id: string | null;
  lat: number | null;
  lon: number | null;
  /** Plain language, written for a phone held in a wind. */
  field_guidance: string | null;
  acked_ts: IsoTimestamp | null;
}

export interface DefectFeedResponse {
  crew_org_id: string;
  server_time: IsoTimestamp;
  defects: FieldDefect[];
}

/** `POST /v1/defects/{id}/ack` — acknowledging is not resolving. */
export interface DefectAckRequest {
  defect_id: string;
  acked_ts: IsoTimestamp;
}

export interface DefectAckResponse {
  defect_id: string;
  acked_ts: IsoTimestamp;
}
