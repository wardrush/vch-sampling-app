/**
 * A13 · v02 §11 criterion 1.
 *
 * *A device in airplane mode for seven simulated days captures 700 points with
 * photographs, then syncs completely over one 4G connection with zero record
 * loss and a per-record acknowledgement for every one.*
 *
 * This is the criterion the whole outbox exists for, and the one that fails
 * quietly: a worker that drops the tail of a large queue looks identical to one
 * that finished, right up until an analyst counts.
 */

import { describe, expect, it } from 'vitest';
import { NodeSqliteDb } from '../support/node-sqlite.js';
import { bootstrapDeviceDb } from '../../src/shared/db/schema.js';
import { OutboxStore } from '../../src/sync/outbox-store.js';
import { OutboxWorker, type SyncTransport } from '../../src/sync/outbox-worker.js';
import type { SyncBatchRequest, SyncBatchResponse } from '../../src/shared/contract/sync.js';

const POINTS = 700;
const PHOTOS_PER_POINT = 3;
const BOUNDARIES = 7; // one field visit per simulated day

/** Acks every record it is given, and records what it saw. */
function ackingTransport(seen: Map<string, number>): SyncTransport {
  return {
    async postBatch(request: SyncBatchRequest): Promise<SyncBatchResponse> {
      for (const record of request.records) {
        seen.set(record.entity_id, (seen.get(record.entity_id) ?? 0) + 1);
      }
      return {
        sync_batch_id: request.sync_batch_id,
        server_received_ts: new Date().toISOString(),
        accepted: request.records.map((r) => r.entity_id),
        rejected: [],
        media_upload_tickets: [],
      };
    },
  };
}

describe('criterion 1 — seven days offline, then one connection', () => {
  it('drains 700 points and their photos with a per-record ack for every one', async () => {
    const db = new NodeSqliteDb();
    await bootstrapDeviceDb(db);
    const store = new OutboxStore(db);

    const expectedIds = new Set<string>();

    for (let v = 0; v < BOUNDARIES; v += 1) {
      const visitId = `visit-${v}`;
      await store.enqueue({
        entity_type: 'field_visit',
        entity_id: visitId,
        payload: { visit_id: visitId, boundary_id: `boundary-${v}` },
        created_ts: new Date().toISOString(),
      });
      expectedIds.add(visitId);
    }

    for (let i = 0; i < POINTS; i += 1) {
      const visitId = `visit-${i % BOUNDARIES}`;
      const sampleUid = `sample-${i}`;
      await store.enqueue({
        entity_type: 'sample_point',
        entity_id: sampleUid,
        payload: { sample_uid: sampleUid, visit_id: visitId, lat: 47.9, lon: -103.2 },
        depends_on: visitId,
        created_ts: new Date().toISOString(),
      });
      expectedIds.add(sampleUid);

      await store.enqueue({
        entity_type: 'sample_bag',
        entity_id: `bag-${i}`,
        payload: { bag_id: `bag-${i}`, sample_uid: sampleUid, barcode_raw: `LB${i}` },
        depends_on: sampleUid,
        created_ts: new Date().toISOString(),
      });
      expectedIds.add(`bag-${i}`);

      for (let p = 0; p < PHOTOS_PER_POINT; p += 1) {
        const mediaId = `media-${i}-${p}`;
        await store.enqueue({
          entity_type: 'media_meta',
          entity_id: mediaId,
          payload: { media_id: mediaId, sample_uid: sampleUid, content_hash: `h${i}${p}` },
          depends_on: sampleUid,
          created_ts: new Date().toISOString(),
        });
        expectedIds.add(mediaId);
      }
    }

    const seen = new Map<string, number>();
    const worker = new OutboxWorker({
      store,
      transport: ackingTransport(seen),
      deviceId: 'dev-test',
      appVersion: '1.0.0',
      maxBatchesPerDrain: 1_000,
    });

    const result = await worker.drain();

    // Zero record loss: every queued entity was sent and acknowledged.
    expect(seen.size).toBe(expectedIds.size);
    for (const id of expectedIds) expect(seen.has(id)).toBe(true);

    const counts = await store.counts();
    expect(counts.acked).toBe(expectedIds.size);
    expect(counts.pending).toBe(0);
    expect(counts.in_flight).toBe(0);
    expect(counts.failed).toBe(0);
    expect(result.accepted).toBe(expectedIds.size);

    // Batched inside the contract's caps rather than sent as one giant POST.
    expect(result.batchesSent).toBeGreaterThan(1);

    db.close();
  });

  it('sends parents before their children', async () => {
    const db = new NodeSqliteDb();
    await bootstrapDeviceDb(db);
    const store = new OutboxStore(db);
    const order: string[] = [];

    await store.enqueue({
      entity_type: 'media_meta',
      entity_id: 'm1',
      payload: { media_id: 'm1', sample_uid: 's1', content_hash: 'h' },
      depends_on: 's1',
      created_ts: new Date().toISOString(),
    });
    await store.enqueue({
      entity_type: 'sample_point',
      entity_id: 's1',
      payload: { sample_uid: 's1', visit_id: 'v1' },
      depends_on: 'v1',
      created_ts: new Date().toISOString(),
    });
    await store.enqueue({
      entity_type: 'field_visit',
      entity_id: 'v1',
      payload: { visit_id: 'v1' },
      created_ts: new Date().toISOString(),
    });

    const worker = new OutboxWorker({
      store,
      transport: {
        async postBatch(request) {
          order.push(...request.records.map((r) => r.entity_id));
          return {
            sync_batch_id: request.sync_batch_id,
            server_received_ts: new Date().toISOString(),
            accepted: request.records.map((r) => r.entity_id),
            rejected: [],
            media_upload_tickets: [],
          };
        },
      },
      deviceId: 'dev',
      appVersion: '1.0.0',
    });

    await worker.drain();
    expect(order).toEqual(['v1', 's1', 'm1']);
    db.close();
  });
});
