/**
 * Per-record validation for `/sync/batch`.
 *
 * **A whole batch is never rejected for one bad record** (contract §3). This
 * module is where that becomes true: it partitions the batch and never throws.
 * Bad records have already landed in `RAW.SYNC_PAYLOAD` by the time it runs, so
 * a rejection is a defect to chase, not data lost.
 */

import type { SyncBatchRequest, SyncRecord, SyncRejection } from '../../shared/contract/sync.js';
import { ENTITY_PRIMARY_KEY } from '../../shared/contract/entities.js';
import type { SyncEntityType } from '../../shared/contract/common.js';
import { isMergeableEntity } from './merge.js';

/** Wire schema versions this deployment can parse. */
export const SUPPORTED_SCHEMA_VERSIONS = new Set(['1.0']);

export interface PartitionedBatch {
  /** Mergeable records, grouped by entity type in contract §5 priority order. */
  byEntity: Map<SyncEntityType, SyncRecord[]>;
  /** Accepted without a MERGE — telemetry and acks handled elsewhere. */
  sideChannel: SyncRecord[];
  rejected: SyncRejection[];
}

export function partitionBatch(request: SyncBatchRequest): PartitionedBatch {
  const byEntity = new Map<SyncEntityType, SyncRecord[]>();
  const sideChannel: SyncRecord[] = [];
  const rejected: SyncRejection[] = [];

  const schemaOk = SUPPORTED_SCHEMA_VERSIONS.has(request.schema_version);

  for (const record of request.records) {
    if (!schemaOk) {
      // Non-retryable: retrying the same bytes against the same deployment
      // will fail identically. The sampler gets a badge and an app update.
      rejected.push({
        entity_id: record.entity_id,
        code: 'SCHEMA_VERSION_UNSUPPORTED',
        retryable: false,
        detail: `schema_version '${request.schema_version}' is not supported by this deployment`,
      });
      continue;
    }

    const problem = validateRecord(record);
    if (problem) {
      rejected.push(problem);
      continue;
    }

    if (record.entity_type === 'app_event' || record.entity_type === 'defect_ack') {
      sideChannel.push(record);
      continue;
    }

    const list = byEntity.get(record.entity_type);
    if (list) list.push(record);
    else byEntity.set(record.entity_type, [record]);
  }

  return { byEntity, sideChannel, rejected };
}

function validateRecord(record: SyncRecord): SyncRejection | null {
  if (!isMergeableEntity(record.entity_type) &&
      record.entity_type !== 'app_event' &&
      record.entity_type !== 'defect_ack') {
    return {
      entity_id: record.entity_id,
      code: 'ENTITY_TYPE_UNKNOWN',
      retryable: false,
      detail: `unknown entity_type '${record.entity_type}'`,
    };
  }

  const payload = record.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      entity_id: record.entity_id,
      code: 'PAYLOAD_INVALID',
      retryable: false,
      detail: 'payload must be an object',
    };
  }

  const keyField = ENTITY_PRIMARY_KEY[record.entity_type];
  const keyValue = (payload as Record<string, unknown>)[keyField];
  if (typeof keyValue !== 'string' || keyValue.length === 0) {
    return {
      entity_id: record.entity_id,
      code: 'PAYLOAD_INVALID',
      retryable: false,
      detail: `payload is missing its client key '${keyField}'`,
    };
  }
  if (keyValue !== record.entity_id) {
    // The envelope and the payload disagreeing about identity is the one
    // inconsistency that would let a MERGE write under the wrong key.
    return {
      entity_id: record.entity_id,
      code: 'PAYLOAD_INVALID',
      retryable: false,
      detail: `entity_id does not match payload.${keyField}`,
    };
  }

  return null;
}
