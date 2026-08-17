/**
 * Ingest endpoints. Addendum §4.3, PLAN_INGEST_SPEC_v01 §5–§7.
 *
 * **The one hard rule, visible in the types: an upload never creates CRM
 * records.** Operation and contact arrive as *text* with a match status and a
 * suggestion. There is no `create_operation` flag anywhere in this file, and
 * adding one would be a schema decision, not a convenience decision.
 */

import type { IsoTimestamp, Uuid7 } from './common.js';

export type CoordFormat = 'decimal' | 'dms' | 'unknown';

export type RowStatus = 'ready' | 'flagged' | 'blocked' | 'committed' | 'superseded';

export type MatchStatus = 'matched' | 'suggested' | 'unmatched' | 'resolved_by_analyst';

export type SourceKind = 'file_upload' | 'clipboard_paste';

/** Spec §3 — the parsed shape of one input row, pre-validation. */
export interface ParsedPlanRow {
  source_row_no: number;
  /** Verbatim, pre-mapping. The reproducibility anchor for the row. */
  raw_values: Record<string, string>;
  plan_point_label: string | null;
  lat_raw: string | null;
  lon_raw: string | null;
  lat: number | null;
  lon: number | null;
  coord_format_detected: CoordFormat;
  coord_fix_applied: string | null;
  boundary_id_stated: string | null;
  field_name: string | null;
  strata_label: string | null;
  elevation_class: string | null;
  sequence_no: number | null;
  access_note: string | null;
  prior_sample_uid: string | null;
  /** Unmapped columns, PRESERVED. A column someone bothered to include is information. */
  extra: Record<string, string>;
  operation_text: string | null;
  contact_name_text: string | null;
  contact_phone_text: string | null;
  contact_email_text: string | null;
}

export interface MatchCandidate {
  id: string;
  label: string;
  score: number;
}

/** Server-side validation output for one row. Additive to the client's own. */
export interface ValidatedPlanRow {
  source_row_no: number;
  boundary_id_resolved: string | null;
  operation_match_id: string | null;
  operation_match_score: number | null;
  operation_match_status: MatchStatus | null;
  operation_candidates: MatchCandidate[];
  contact_match_id: string | null;
  contact_match_score: number | null;
  contact_match_status: MatchStatus | null;
  contact_candidates: MatchCandidate[];
  row_status: RowStatus;
  validation_codes: string[];
}

export interface IngestValidateRequest {
  period_code: string;
  project_id: string | null;
  rows: ParsedPlanRow[];
}

export interface IngestValidateResponse {
  server_time: IsoTimestamp;
  rows: ValidatedPlanRow[];
  summary: IngestSummary;
}

/** Spec §5 — "312 rows · 298 ready · 9 need review · 5 blocked". */
export interface IngestSummary {
  row_count: number;
  rows_ready: number;
  rows_flagged: number;
  rows_blocked: number;
}

/**
 * `POST /ingest/commit`.
 *
 * Idempotent on `content_hash` + `imported_by` + mapping, so a double-click
 * cannot double-import. The workbook never reaches the function — SheetJS
 * parses client-side and commit sends parsed JSON. The raw *bytes* (or the
 * pasted text) travel separately in `raw_file`, for `RAW.PLAN_IMPORT_FILE`.
 */
export interface IngestCommitRequest {
  period_code: string;
  project_id: string | null;
  /** The resolved column mapping. Makes the import reproducible from raw. */
  mapping: Record<string, string>;
  raw_file: {
    content_hash: string;
    original_filename: string | null;
    mime_type: string | null;
    bytes: number;
    source_kind: SourceKind;
    /** base64 for `file_upload`; omitted when `raw_text` carries the artefact. */
    content_b64?: string;
    /** The pasted block, verbatim. For a paste, the text *is* the artefact. */
    raw_text?: string;
  };
  rows: ParsedPlanRow[];
  /** Per-row validation as shown to the user at the moment they pressed commit. */
  validated: ValidatedPlanRow[];
  /** Tutorial commits are written to a sandbox and discarded. Spec §8. */
  sandbox?: boolean;
}

export interface IngestCommitResponse {
  import_id: string;
  content_hash: string;
  /** True when this request matched an existing import and wrote nothing new. */
  idempotent_replay: boolean;
  status: 'committed' | 'blocked';
  plan_ids: string[];
  row_count: number;
  rows_committed: number;
  rows_flagged: number;
  rows_blocked: number;
  /** Unresolved operations/contacts raised into the analyst queue. */
  queue_items: number;
  imported_ts: IsoTimestamp;
}

/** `POST /ingest/retire/{import_id}` — refuses once any point is sampled. */
export interface IngestRetireRequest {
  import_id: string;
  reason: string | null;
}

export interface IngestRetireResponse {
  import_id: string;
  outcome: 'retired' | 'refused';
  /** Set on refusal. Both outcomes write an AUDIT_EVENT, including this one. */
  code?: 'POINTS_ALREADY_SAMPLED' | 'NOT_FOUND' | 'ALREADY_RETIRED';
  sampled_point_count?: number;
  plan_ids: string[];
  retired_ts: IsoTimestamp | null;
}

export type IngestSessionId = Uuid7;
