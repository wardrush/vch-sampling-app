/**
 * The rule interface. A7 owns this shape; A8 writes rules against it.
 *
 * **Every rule is a pure function of its context.** No IO, no clock, no
 * randomness — the harness does all the loading and all the writing. That is
 * what lets each of A8's rules be a fixture and an assertion, which is exactly
 * the shape v02 Appendix A puts in the cheap tier *once the harness exists*.
 */

import type { DefectSeverity } from '../../shared/contract/common.js';

export interface RuleSample {
  sample_uid: string;
  visit_id: string | null;
  plan_point_id: string | null;
  boundary_id: string | null;
  lat: number | null;
  lon: number | null;
  gps_accuracy_m: number | null;
  fix_count: number | null;
  fix_spread_m: number | null;
  position_source: string | null;
  offset_from_plan_m: number | null;
  deviation_reason_code: string | null;
  captured_ts_device: string | null;
  device_uptime_ms: number | null;
  server_received_ts: string | null;
  depth_achieved_cm: number | null;
  spec_id: string | null;
}

export interface RuleBag {
  bag_id: string;
  sample_uid: string;
  lab_id: string | null;
  barcode_raw: string | null;
  barcode_capture_method: string | null;
  void_flag: boolean;
}

export interface RuleMedia {
  media_id: string;
  sample_uid: string | null;
  media_role: string;
  is_required_role: boolean;
  capture_source: string;
  exif_lat: number | null;
  exif_lon: number | null;
  exif_ts: string | null;
}

export interface RuleSpec {
  spec_id: string;
  required_media_roles: string[];
  gps_accuracy_required_m: number | null;
  min_gps_fix_count: number | null;
  max_plan_offset_m_warn: number | null;
  max_plan_offset_m_block: number | null;
  depth_top_cm: number | null;
  depth_bottom_cm: number | null;
}

export interface RuleContext {
  sync_batch_id: string;
  samples: RuleSample[];
  bags: RuleBag[];
  media: RuleMedia[];
  specs: Map<string, RuleSpec>;
  /**
   * Barcodes already in the warehouse outside this batch, keyed
   * `lab_id|barcode_raw`. Loaded by the harness so a duplicate-detection rule
   * stays a pure function over a set rather than a query per bag.
   */
  knownBarcodes: Map<string, string>;
}

export interface DefectFinding {
  /** Exactly one of these three identifies the subject. */
  sample_uid?: string | null;
  bag_id?: string | null;
  visit_id?: string | null;
  plan_point_id?: string | null;
  defect_code: string;
  severity: DefectSeverity;
  detail: string;
}

export interface DefectRule {
  code: string;
  /** One line, in the language the analyst queue will show. */
  description: string;
  run(ctx: RuleContext): DefectFinding[];
}
