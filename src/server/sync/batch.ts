/**
 * A4 — `/sync/batch`. Contract §3, §6 steps 1–2, 9.
 *
 * Order is the whole design:
 *
 *   1. **Persist the body verbatim, content-hashed, before parsing anything.**
 *      Bad records land in RAW regardless and become a defect, not a data loss.
 *      This step is the one someone who has not yet needed it will cut, and it
 *      is the reason `CURATED` can be rebuilt (v02 §11.5).
 *   2. Parse and MERGE on the client keys — per entity type, never per record.
 *   3. Answer per record. A whole batch is never rejected for one bad one.
 *   4. Hand the derivation pipeline a `sync_batch_id`, never data.
 *
 * A re-POST of a batch already accepted short-circuits at step 0 and returns
 * the acknowledgement it returned the first time (v02 §11.4). Media tickets are
 * re-issued rather than replayed, because a ticket expires and a stale URL
 * would be a worse kind of "identical".
 */

import { createHash } from 'node:crypto';
import type {
  SyncBatchRequest,
  SyncBatchResponse,
  SyncRejection,
} from '../../shared/contract/sync.js';
import { OUTBOX_PRIORITY } from '../../shared/contract/sync.js';
import type { MediaMetaPayload } from '../../shared/contract/entities.js';
import type { SnowflakeClient } from '../../shared/snowflake/client.js';
import { asObjects } from '../../shared/snowflake/client.js';
import { type BlobStore, rawPayloadKey } from '../storage/blobs.js';
import type { MediaTicketIssuer } from '../media/tickets.js';
import { curatedMergeSql } from './merge.js';
import { partitionBatch } from './validate.js';

export interface DerivationTrigger {
  /** Payload is the id and nothing else — the background cap is 256 KB. */
  trigger(syncBatchId: string): Promise<void>;
}

export interface SyncBatchDeps {
  snowflake: SnowflakeClient;
  blobs: BlobStore;
  tickets: MediaTicketIssuer;
  derivation: DerivationTrigger;
  now?: () => number;
}

const ackKey = (batchId: string) => `raw/sync/ack/${batchId}.json`;

/**
 * @param rawBody the request body **exactly as received**. The hash is taken
 *   over these bytes, not over a re-serialisation of the parsed object — a
 *   round trip through `JSON.stringify` reorders keys and the hash stops
 *   addressing what actually arrived.
 */
export async function handleSyncBatch(
  rawBody: Uint8Array,
  request: SyncBatchRequest,
  deps: SyncBatchDeps,
): Promise<SyncBatchResponse> {
  const now = deps.now ?? Date.now;
  const receivedTs = new Date(now()).toISOString();
  const payloadHash = createHash('sha256').update(rawBody).digest('hex');

  // ---- 0. Replay -----------------------------------------------------------
  const priorAck = await deps.blobs.get(ackKey(request.sync_batch_id));
  if (priorAck) {
    const previous = JSON.parse(new TextDecoder().decode(priorAck)) as SyncBatchResponse;
    if (previous.raw_payload_hash === payloadHash) {
      return {
        ...previous,
        media_upload_tickets: await deps.tickets.issue(mediaPayloads(request)),
      };
    }
    // Same idempotency key, different bytes. The MERGE is idempotent on the
    // client keys either way, so process it — but do not pretend it was a
    // replay.
  }

  // ---- 1. Verbatim RAW, before any parsing ---------------------------------
  await deps.blobs.put(rawPayloadKey(payloadHash), rawBody, {
    sync_batch_id: request.sync_batch_id,
    device_id: request.device_id,
  });
  await persistRaw(deps.snowflake, request, rawBody, payloadHash, receivedTs);

  // ---- 2. Parse and MERGE --------------------------------------------------
  const { byEntity, sideChannel, rejected } = partitionBatch(request);
  const accepted: string[] = sideChannel.map((r) => r.entity_id);

  // Contract §5 order: parents before children, so a batch carrying both lands
  // referentially sound even though the warehouse does not enforce it.
  const ordered = [...byEntity.entries()].sort(
    (a, b) => (OUTBOX_PRIORITY[a[0]] ?? 100) - (OUTBOX_PRIORITY[b[0]] ?? 100),
  );

  for (const [entityType, records] of ordered) {
    const payloads = records.map((r) => r.payload);
    try {
      await deps.snowflake.execute(
        curatedMergeSql(entityType as never, 'PARSE_JSON(?)', '?'),
        { binds: [JSON.stringify(payloads), request.sync_batch_id] },
      );
      accepted.push(...records.map((r) => r.entity_id));
    } catch (err) {
      // Degrade, don't fail. The warehouse being unavailable is retryable by
      // definition, and the records are already durable in RAW — this is a
      // "come back in five minutes", not a lost sample.
      const detail = err instanceof Error ? err.message : String(err);
      for (const record of records) {
        rejected.push({
          entity_id: record.entity_id,
          code: 'WAREHOUSE_UNAVAILABLE',
          retryable: true,
          detail,
        } satisfies SyncRejection);
      }
    }
  }

  // ---- 3. Batch bookkeeping (contract §6 step 9) ---------------------------
  await recordBatch(deps.snowflake, request, payloadHash, accepted.length, rejected.length, receivedTs);

  const response: SyncBatchResponse = {
    sync_batch_id: request.sync_batch_id,
    server_received_ts: receivedTs,
    accepted,
    rejected,
    media_upload_tickets: await deps.tickets.issue(mediaPayloads(request)),
    raw_payload_hash: payloadHash,
  };

  // Stored without the tickets: they expire, and a replay should re-issue
  // rather than hand back a URL that stopped working overnight.
  await deps.blobs.put(
    ackKey(request.sync_batch_id),
    new TextEncoder().encode(JSON.stringify({ ...response, media_upload_tickets: [] })),
  );

  // ---- 4. Kick the pipeline. Id only, never data. --------------------------
  if (accepted.length > 0) {
    try {
      await deps.derivation.trigger(request.sync_batch_id);
    } catch {
      // The nightly sweep re-enumerates batches with no derivation run, so a
      // failed kick delays the analyst queue by hours rather than losing it.
      // Not worth failing an acknowledged batch over.
    }
  }

  return response;
}

function mediaPayloads(request: SyncBatchRequest): MediaMetaPayload[] {
  return request.records
    .filter((r) => r.entity_type === 'media_meta')
    .map((r) => r.payload as MediaMetaPayload)
    .filter((p) => typeof p?.content_hash === 'string' && typeof p?.media_id === 'string');
}

async function persistRaw(
  snowflake: SnowflakeClient,
  request: SyncBatchRequest,
  rawBody: Uint8Array,
  payloadHash: string,
  receivedTs: string,
): Promise<void> {
  // Idempotent on the hash: identical bytes are the same artefact, and a
  // client retrying a timed-out batch must not create a second RAW row.
  await snowflake.execute(
    `INSERT INTO RAW.SYNC_PAYLOAD
       (RAW_PAYLOAD_HASH, DEVICE_ID, SYNC_BATCH_ID, PAYLOAD, PAYLOAD_BYTES,
        SCHEMA_VERSION, APP_VERSION, RECEIVED_TS)
     SELECT ?, ?, ?, PARSE_JSON(?), ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM RAW.SYNC_PAYLOAD WHERE RAW_PAYLOAD_HASH = ?
      )`,
    {
      binds: [
        payloadHash,
        request.device_id,
        request.sync_batch_id,
        new TextDecoder().decode(rawBody),
        rawBody.byteLength,
        request.schema_version,
        request.app_version,
        receivedTs,
        payloadHash,
      ],
    },
  );
}

async function recordBatch(
  snowflake: SnowflakeClient,
  request: SyncBatchRequest,
  payloadHash: string,
  acceptedCount: number,
  rejectedCount: number,
  receivedTs: string,
): Promise<void> {
  await snowflake.executeMulti(
    [
      `MERGE INTO CURATED.SYNC_BATCH t
       USING (SELECT ? AS SYNC_BATCH_ID, ? AS DEVICE_ID, ? AS CLIENT_SENT_TS,
                     ? AS SERVER_RECEIVED_TS, ? AS RECORD_COUNT, ? AS ACCEPTED_COUNT,
                     ? AS REJECTED_COUNT, ? AS RAW_PAYLOAD_HASH, ? AS APP_VERSION,
                     ? AS SCHEMA_VERSION) s
          ON t.SYNC_BATCH_ID = s.SYNC_BATCH_ID
        WHEN MATCHED THEN UPDATE SET
             ACCEPTED_COUNT = s.ACCEPTED_COUNT,
             REJECTED_COUNT = s.REJECTED_COUNT,
             SERVER_RECEIVED_TS = s.SERVER_RECEIVED_TS
        WHEN NOT MATCHED THEN
             INSERT (SYNC_BATCH_ID, DEVICE_ID, CLIENT_SENT_TS, SERVER_RECEIVED_TS,
                     RECORD_COUNT, ACCEPTED_COUNT, REJECTED_COUNT, RAW_PAYLOAD_HASH,
                     APP_VERSION, SCHEMA_VERSION)
             VALUES (s.SYNC_BATCH_ID, s.DEVICE_ID, s.CLIENT_SENT_TS, s.SERVER_RECEIVED_TS,
                     s.RECORD_COUNT, s.ACCEPTED_COUNT, s.REJECTED_COUNT, s.RAW_PAYLOAD_HASH,
                     s.APP_VERSION, s.SCHEMA_VERSION)`,
      `UPDATE CURATED.DEVICE SET LAST_SEEN_TS = ? WHERE DEVICE_ID = ?`,
    ],
    {
      binds: [
        request.sync_batch_id,
        request.device_id,
        request.client_sent_ts,
        receivedTs,
        request.records.length,
        acceptedCount,
        rejectedCount,
        payloadHash,
        request.app_version,
        request.schema_version,
        receivedTs,
        request.device_id,
      ],
    },
  );
}

/**
 * Re-runs the parse over `RAW.SYNC_PAYLOAD` for one batch.
 *
 * v02 §11 criterion 5 in executable form. It uses `curatedMergeSql` with a
 * different source expression and nothing else changes — which is the only
 * honest way to claim the curated layer is rebuildable.
 */
export async function rebuildCuratedFromRaw(
  snowflake: SnowflakeClient,
  entityTypes: readonly string[],
  syncBatchId?: string,
): Promise<void> {
  for (const entityType of entityTypes) {
    const source = `(
      SELECT ARRAY_AGG(rec.value:payload)
        FROM RAW.SYNC_PAYLOAD p,
             TABLE(FLATTEN(input => p.PAYLOAD:records)) rec
       WHERE rec.value:entity_type::VARCHAR = '${entityType}'
         ${syncBatchId ? 'AND p.SYNC_BATCH_ID = ?' : ''}
    )`;
    await snowflake.execute(
      curatedMergeSql(entityType as never, source, syncBatchId ? '?' : 'NULL'),
      { binds: syncBatchId ? [syncBatchId, syncBatchId] : [] },
    );
  }
}

/** Convenience for the acceptance test and the nightly rebuild job. */
export async function listBatchRawHashes(
  snowflake: SnowflakeClient,
): Promise<Array<{ sync_batch_id: string; raw_payload_hash: string }>> {
  const result = await snowflake.execute(
    `SELECT SYNC_BATCH_ID, RAW_PAYLOAD_HASH FROM RAW.SYNC_PAYLOAD ORDER BY RECEIVED_TS`,
  );
  return asObjects<{ sync_batch_id: string; raw_payload_hash: string }>(result);
}
