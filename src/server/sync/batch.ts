/**
 * A4 — `/sync/batch`. Contract §3, §6 steps 1–2, 9.
 *
 * Order is the whole design:
 *
 *   1. **Persist the body verbatim, content-hashed, before parsing anything.**
 *      Bad records land in RAW regardless and become a defect, not a data loss.
 *      This step is the one someone who has not yet needed it will cut, and it
 *      is the reason `CURATED` can be rebuilt (v02 §11.5).
 *   2. Parse and upsert on the client keys — per entity type, never per record.
 *   3. Answer per record. A whole batch is never rejected for one bad one.
 *   4. Hand the derivation pipeline a `sync_batch_id`, never data.
 *
 * A re-POST of a batch already accepted short-circuits at step 0 and returns
 * the acknowledgement it returned the first time (v02 §11.4). Media tickets are
 * re-issued rather than replayed, because a ticket expires and a stale URL
 * would be a worse kind of "identical".
 *
 * **Backend-independent by construction.** Everything here goes through
 * `SqlClient`, and the two dialects' SQL comes from one mapping in `./merge.ts`
 * plus the fragments in `./dialect.ts`. The content hash in particular is taken
 * over the received bytes and never over anything read back out of a database —
 * `jsonb` normalises key order and drops duplicate keys, and so does Snowflake's
 * `VARIANT`, so a hash over a round-tripped payload would address something that
 * never arrived.
 */

import { createHash } from 'node:crypto';
import type {
  SyncBatchRequest,
  SyncBatchResponse,
  SyncRejection,
} from '../../shared/contract/sync.js';
import { OUTBOX_PRIORITY } from '../../shared/contract/sync.js';
import type { SyncEntityType } from '../../shared/contract/common.js';
import type { MediaMetaPayload } from '../../shared/contract/entities.js';
import type { SqlClient, SqlDialect } from '../../shared/db/port.js';
import { asObjects } from '../../shared/db/port.js';
import { type BlobStore, rawPayloadKey } from '../storage/blobs.js';
import type { MediaTicketIssuer } from '../media/tickets.js';
import {
  curatedMergeSql,
  curatedWriteForPayload,
  isMergeableEntity,
  keyPathFor,
  type MergeableEntityType,
} from './merge.js';
import { syntaxFor } from './dialect.js';
import { partitionBatch } from './validate.js';

export interface DerivationTrigger {
  /** Payload is the id and nothing else — the background cap is 256 KB. */
  trigger(syncBatchId: string): Promise<void>;
}

export interface SyncBatchDeps {
  /**
   * The warehouse or the Netlify database, behind the port. The field keeps its
   * name so every existing caller and test reads unchanged.
   */
  snowflake: SqlClient;
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
  const dialect = deps.snowflake.dialect;

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
    // Same idempotency key, different bytes. The upsert is idempotent on the
    // client keys either way, so process it — but do not pretend it was a
    // replay.
  }

  // ---- 1. Verbatim RAW, before any parsing ---------------------------------
  await deps.blobs.put(rawPayloadKey(payloadHash), rawBody, {
    sync_batch_id: request.sync_batch_id,
    device_id: request.device_id,
  });
  await persistRaw(deps.snowflake, request, rawBody, payloadHash, receivedTs);

  // ---- 2. Parse and upsert -------------------------------------------------
  const { byEntity, sideChannel, rejected } = partitionBatch(request);
  const accepted: string[] = sideChannel.map((r) => r.entity_id);

  // Contract §5 order: parents before children, so a batch carrying both lands
  // referentially sound even though neither backend enforces referential
  // integrity — deliberately, so a child that arrives first becomes a defect
  // rather than a rejected sample.
  const ordered = [...byEntity.entries()].sort(
    (a, b) => (OUTBOX_PRIORITY[a[0]] ?? 100) - (OUTBOX_PRIORITY[b[0]] ?? 100),
  );

  for (const [entityType, records] of ordered) {
    if (!isMergeableEntity(entityType)) continue;
    // Last occurrence of a client key wins, matching the outbox's own
    // `ON CONFLICT DO UPDATE` on `(entity_type, entity_id, operation)`. A
    // conforming client cannot send the same key twice in one batch; a
    // non-conforming one must not be able to poison a batch that then retries
    // forever.
    const payloads = dedupeByKey(records.map((r) => r.payload), entityType);
    const write = curatedWriteForPayload(
      entityType,
      JSON.stringify(payloads),
      request.sync_batch_id,
      dialect,
    );
    try {
      await deps.snowflake.execute(write.sql, { binds: write.binds });
      accepted.push(...records.map((r) => r.entity_id));
    } catch (err) {
      // Degrade, don't fail. The database being unavailable is retryable by
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

/** Last occurrence per client key, order otherwise preserved. */
function dedupeByKey(payloads: unknown[], entityType: MergeableEntityType): unknown[] {
  const keyPath = keyPathFor(entityType);
  const byKey = new Map<string, unknown>();
  const unkeyed: unknown[] = [];
  for (const payload of payloads) {
    const key = (payload as Record<string, unknown> | null)?.[keyPath];
    if (typeof key === 'string') byKey.set(key, payload);
    else unkeyed.push(payload);
  }
  return [...byKey.values(), ...unkeyed];
}

async function persistRaw(
  db: SqlClient,
  request: SyncBatchRequest,
  rawBody: Uint8Array,
  payloadHash: string,
  receivedTs: string,
): Promise<void> {
  // Valid UTF-8 decodes and re-encodes to the same bytes, which is the
  // assumption both backends' RAW rows already make. Netlify Blobs holds the
  // authoritative bytes either way (step 1 above).
  const payloadText = new TextDecoder().decode(rawBody);

  if (db.dialect === 'postgres') {
    // PAYLOAD_TEXT is the hash anchor: verbatim, never updated. PAYLOAD is the
    // queryable jsonb projection of the *same bind, in the same statement* — so
    // `sha256(PAYLOAD_TEXT) = RAW_PAYLOAD_HASH` stays a checkable statement
    // rather than an article of faith. Idempotent on the hash: identical bytes
    // are the same artefact, and a client retrying a timed-out batch must not
    // create a second RAW row.
    await db.execute(
      `INSERT INTO RAW.SYNC_PAYLOAD
         (RAW_PAYLOAD_HASH, DEVICE_ID, SYNC_BATCH_ID, PAYLOAD_TEXT, PAYLOAD, PAYLOAD_BYTES,
          SCHEMA_VERSION, APP_VERSION, RECEIVED_TS)
       VALUES (?, ?, ?, ?, (?)::jsonb, ?, ?, ?, ?)
       ON CONFLICT (RAW_PAYLOAD_HASH) DO NOTHING`,
      {
        binds: [
          payloadHash,
          request.device_id,
          request.sync_batch_id,
          payloadText,
          payloadText,
          rawBody.byteLength,
          request.schema_version,
          request.app_version,
          receivedTs,
        ],
      },
    );
    return;
  }

  await db.execute(
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
        payloadText,
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
  db: SqlClient,
  request: SyncBatchRequest,
  payloadHash: string,
  acceptedCount: number,
  rejectedCount: number,
  receivedTs: string,
): Promise<void> {
  const syntax = syntaxFor(db);
  // Ten binds for the batch row, two for the device row, in this order on both
  // backends — `executeMulti` takes one flat positional array and the Postgres
  // adapter splits it by counting placeholders.
  const binds = [
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
  ];

  const batchRow =
    syntax.dialect === 'postgres'
      ? `INSERT INTO CURATED.SYNC_BATCH AS t
           (SYNC_BATCH_ID, DEVICE_ID, CLIENT_SENT_TS, SERVER_RECEIVED_TS, RECORD_COUNT,
            ACCEPTED_COUNT, REJECTED_COUNT, RAW_PAYLOAD_HASH, APP_VERSION, SCHEMA_VERSION)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (SYNC_BATCH_ID) DO UPDATE SET
            ACCEPTED_COUNT = EXCLUDED.ACCEPTED_COUNT,
            REJECTED_COUNT = EXCLUDED.REJECTED_COUNT,
            SERVER_RECEIVED_TS = EXCLUDED.SERVER_RECEIVED_TS`
      : `MERGE INTO CURATED.SYNC_BATCH t
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
                     s.APP_VERSION, s.SCHEMA_VERSION)`;

  await db.executeMulti(
    [batchRow, `UPDATE CURATED.DEVICE SET LAST_SEEN_TS = ? WHERE DEVICE_ID = ?`],
    { binds },
  );
}

/**
 * The rebuild path's source expression: every record of one entity type inside
 * **one** RAW payload.
 *
 * One RAW row at a time, rather than one aggregate over all of them, and that is
 * a correctness point rather than a style one. `ARRAY_AGG` / `jsonb_agg` over
 * many payloads has no defined order, so a sample corrected in a later batch
 * could be rebuilt from the *earlier* payload — a rebuild that is not
 * deterministic does not satisfy v02 §11 criterion 5 whatever it produces.
 * Replaying payloads in `RECEIVED_TS` order makes last-writer-wins mean the same
 * thing on the rebuild path as it does on the live path.
 *
 * Contains exactly one placeholder, for the RAW payload hash.
 */
export function rawRebuildSourceSql(entityType: MergeableEntityType, dialect: SqlDialect): string {
  const syntax = syntaxFor(dialect);
  const records = syntax.jsonSubtree('p.PAYLOAD', 'records');
  return `(
      SELECT ${syntax.jsonArrayAgg(syntax.jsonSubtree('rec.value', 'payload'))}
        FROM RAW.SYNC_PAYLOAD p,
             ${syntax.jsonArrayRows(records, 'rec')}
       WHERE ${syntax.jsonScalar('rec.value', 'entity_type', 'text')} = '${entityType}'
         AND p.RAW_PAYLOAD_HASH = ?
    )`;
}

/**
 * Re-runs the parse over `RAW.SYNC_PAYLOAD`.
 *
 * v02 §11 criterion 5 in executable form. It uses `curatedMergeSql` with a
 * different source expression and nothing else changes — which is the only
 * honest way to claim the curated layer is rebuildable.
 *
 * Each payload is replayed in arrival order, and each row is re-stamped with the
 * `SYNC_BATCH_ID` it originally arrived under, so the derivation pipeline — which
 * is keyed on that column — can be re-run afterwards exactly as it was the first
 * time.
 */
export async function rebuildCuratedFromRaw(
  db: SqlClient,
  entityTypes: readonly string[],
  syncBatchId?: string,
): Promise<void> {
  const mergeable = entityTypes
    .filter((t): t is MergeableEntityType => isMergeableEntity(t as SyncEntityType))
    .sort((a, b) => (OUTBOX_PRIORITY[a] ?? 100) - (OUTBOX_PRIORITY[b] ?? 100));

  for (const payload of await listBatchRawHashes(db, syncBatchId)) {
    for (const entityType of mergeable) {
      await db.execute(
        curatedMergeSql(entityType, rawRebuildSourceSql(entityType, db.dialect), '?', db.dialect),
        // Batch id first, then the payload hash inside the source expression —
        // the order the SQL mentions them. See `./merge.ts`.
        { binds: [payload.sync_batch_id, payload.raw_payload_hash] },
      );
    }
  }
}

/** Convenience for the acceptance test and the nightly rebuild job. */
export async function listBatchRawHashes(
  db: SqlClient,
  syncBatchId?: string,
): Promise<Array<{ sync_batch_id: string; raw_payload_hash: string }>> {
  const result = await db.execute(
    `SELECT SYNC_BATCH_ID, RAW_PAYLOAD_HASH FROM RAW.SYNC_PAYLOAD
      ${syncBatchId ? 'WHERE SYNC_BATCH_ID = ?' : ''}
      ORDER BY RECEIVED_TS`,
    { binds: syncBatchId ? [syncBatchId] : [] },
  );
  return asObjects<{ sync_batch_id: string; raw_payload_hash: string }>(result);
}
