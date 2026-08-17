/**
 * A13 · v02 §11 criterion 2.
 *
 * *Killing the app mid-capture loses at most the current, uncommitted point.
 * Verified by force-quit during capture, twenty times.*
 *
 * A force-quit is modelled the way it actually happens: the process disappears
 * between the statement that marked a batch in-flight and the response that
 * would have acked it. The next launch constructs a fresh worker over the same
 * database — no in-memory state survives, because on a phone none does.
 *
 * The property that makes this safe is that a resumed batch is re-sent **under
 * its original `sync_batch_id`**, so a server that had already committed it
 * sees a replay rather than a second batch.
 */

import { describe, expect, it } from 'vitest';
import { NodeSqliteDb } from '../support/node-sqlite.js';
import { bootstrapDeviceDb } from '../../src/shared/db/schema.js';
import { OutboxStore } from '../../src/sync/outbox-store.js';
import { OutboxWorker, TransportError, type SyncTransport } from '../../src/sync/outbox-worker.js';
import type { SyncBatchRequest, SyncBatchResponse } from '../../src/shared/contract/sync.js';

/** Accepts everything, but the caller "dies" before the response is applied. */
class ServerThatCommits implements SyncTransport {
  readonly committed = new Set<string>();
  readonly batchIds: string[] = [];
  killNext = false;

  async postBatch(request: SyncBatchRequest): Promise<SyncBatchResponse> {
    this.batchIds.push(request.sync_batch_id);
    for (const record of request.records) this.committed.add(record.entity_id);

    if (this.killNext) {
      this.killNext = false;
      // The server committed; the client never learns. This is the exact
      // window a force-quit lands in, and the one blind retry must survive.
      throw new TransportError('process died before the response was read', true);
    }
    return {
      sync_batch_id: request.sync_batch_id,
      server_received_ts: new Date().toISOString(),
      accepted: request.records.map((r) => r.entity_id),
      rejected: [],
      media_upload_tickets: [],
    };
  }
}

describe('criterion 2 — force-quit during capture, twenty times', () => {
  it('loses nothing that reached the outbox, across twenty kills', async () => {
    const db = new NodeSqliteDb();
    await bootstrapDeviceDb(db);
    const store = new OutboxStore(db);
    const server = new ServerThatCommits();
    const expected: string[] = [];

    for (let round = 0; round < 20; round += 1) {
      const sampleUid = `sample-${round}`;
      expected.push(sampleUid);
      await store.enqueue({
        entity_type: 'sample_point',
        entity_id: sampleUid,
        payload: { sample_uid: sampleUid, visit_id: 'v1', lat: 47.9, lon: -103.2 },
        created_ts: new Date().toISOString(),
      });

      // Force-quit: the send is attempted, the process dies, and the next
      // launch gets a brand-new worker with no memory of the attempt.
      server.killNext = true;
      const dying = newWorker(store, server);
      await dying.drain();

      const relaunched = newWorker(store, server);
      // `force` stands in for the sampler tapping "sync now" after a relaunch;
      // without it the fresh worker would honour its own backoff timer.
      await relaunched.drain({ force: true });
    }

    const counts = await store.counts();
    expect(counts.acked).toBe(expected.length);
    expect(counts.pending).toBe(0);
    expect(counts.in_flight).toBe(0);
    expect(counts.failed).toBe(0);

    for (const id of expected) expect(server.committed.has(id)).toBe(true);

    db.close();
  });

  it('resends an interrupted batch under its original sync_batch_id', async () => {
    const db = new NodeSqliteDb();
    await bootstrapDeviceDb(db);
    const store = new OutboxStore(db);
    const server = new ServerThatCommits();

    await store.enqueue({
      entity_type: 'sample_point',
      entity_id: 's1',
      payload: { sample_uid: 's1', visit_id: 'v1' },
      created_ts: new Date().toISOString(),
    });

    server.killNext = true;
    await newWorker(store, server).drain();

    const afterKill = await store.inFlight();
    expect(afterKill).toHaveLength(1);
    const originalBatchId = afterKill[0]!.sync_batch_id;
    expect(originalBatchId).toBeTruthy();

    await newWorker(store, server).drain({ force: true });

    expect(server.batchIds).toEqual([originalBatchId, originalBatchId]);
    expect((await store.counts()).acked).toBe(1);

    db.close();
  });
});

function newWorker(store: OutboxStore, transport: SyncTransport): OutboxWorker {
  return new OutboxWorker({ store, transport, deviceId: 'dev', appVersion: '1.0.0' });
}
