/**
 * Up-sync: records. SYNC_CONTRACT_v01 §3, §5.
 *
 * The contract detail that decides whether a season survives:
 * **a whole batch is never rejected for one bad record.** The response is
 * per-record, always, even on partial failure. `retryable` is explicit,
 * because a silently-stuck outbox is the failure mode that loses a season.
 */

import type {
  IsoTimestamp,
  SchemaVersion,
  SyncEntityType,
  Uuid7,
  HexHash,
} from './common.js';
import type { MediaTicket } from './media.js';

/** Contract §3 — 200 records or 2 MB, whichever comes first. */
export const BATCH_MAX_RECORDS = 200;
export const BATCH_MAX_BYTES = 2 * 1024 * 1024;

export interface SyncRecord<P = unknown> {
  entity_type: SyncEntityType;
  entity_id: Uuid7;
  /** `upsert` is the only operation. Corrections are new rows. */
  operation?: 'upsert';
  payload: P;
}

export interface SyncBatchRequest {
  /** Also the `Idempotency-Key` header. Re-sending is safe by construction. */
  sync_batch_id: Uuid7;
  device_id: string;
  app_version: string;
  schema_version: SchemaVersion;
  client_sent_ts: IsoTimestamp;
  records: SyncRecord[];
}

/**
 * Rejection codes. `retryable` is carried per rejection rather than inferred
 * from the code, so the server can downgrade a normally-permanent failure to
 * retryable during an incident without shipping a client.
 */
export type RejectionCode =
  | 'SCHEMA_VERSION_UNSUPPORTED'
  | 'PAYLOAD_INVALID'
  | 'ENTITY_TYPE_UNKNOWN'
  | 'PARENT_NOT_FOUND'
  | 'RECORD_IMMUTABLE'
  | 'DEVICE_REVOKED'
  | 'WAREHOUSE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export interface SyncRejection {
  entity_id: Uuid7;
  code: RejectionCode | string;
  retryable: boolean;
  detail?: string;
}

export interface SyncBatchResponse {
  sync_batch_id: Uuid7;
  server_received_ts: IsoTimestamp;
  /** Entity ids the server has durably taken. Nothing else counts as synced. */
  accepted: Uuid7[];
  rejected: SyncRejection[];
  media_upload_tickets: MediaTicket[];
  /**
   * Hash of the verbatim body as persisted to RAW. Returned so a client (or an
   * acceptance test) can prove the round trip without reading the warehouse.
   */
  raw_payload_hash?: HexHash;
}

/**
 * SYNC_CONTRACT §5. Lower goes first. JSON before media, always — a sample
 * record is ~4 KB and must land the moment a signal appears; a photo is
 * ~350 KB and can take days.
 *
 * `defect_ack` at 45 comes from device_sqlite_v02_addendum: small, useful,
 * never competes with data.
 */
export const OUTBOX_PRIORITY: Record<SyncEntityType | 'media_bytes', number> = {
  field_visit: 10,
  sample_point: 20,
  sample_bag: 30,
  sample_condition: 30,
  local_defect: 30,
  media_meta: 40,
  defect_ack: 45,
  media_bytes: 90,
  app_event: 95,
};

/** Contract §3 — 5 s, 30 s, 2 min, 10 min, 1 h, then hourly. Jittered. */
export const BACKOFF_SCHEDULE_MS: readonly number[] = [
  5_000,
  30_000,
  120_000,
  600_000,
  3_600_000,
];
