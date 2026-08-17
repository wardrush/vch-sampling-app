/**
 * A13 · v02 §11 criterion 4.
 *
 * *Re-POSTing an already-accepted batch changes nothing and returns the same
 * acknowledgement.*
 *
 * "Changes nothing" is checked literally: the second call must issue no MERGE
 * at all. An implementation that re-ran an idempotent MERGE would return the
 * same answer and still fail this test, which is deliberate — re-running the
 * write burns warehouse credits on every retry a flaky connection produces, and
 * the whole design assumes retries are the normal case rather than the
 * exception.
 */

import { describe, expect, it } from 'vitest';
import { FakeSnowflake } from '../support/fake-snowflake.js';
import { MemoryBlobStore } from '../../src/server/storage/blobs.js';
import { MediaTicketIssuer } from '../../src/server/media/tickets.js';
import { handleSyncBatch } from '../../src/server/sync/batch.js';
import type { SyncBatchRequest } from '../../src/shared/contract/sync.js';

function batch(): SyncBatchRequest {
  return {
    sync_batch_id: '01J9BATCH000000000000000001',
    device_id: 'dev-1',
    app_version: '1.0.4',
    schema_version: '1.0',
    client_sent_ts: '2026-10-02T23:11:04Z',
    records: [
      {
        entity_type: 'field_visit',
        entity_id: 'v1',
        payload: { visit_id: 'v1', boundary_id: 'b1' },
      },
      {
        entity_type: 'sample_point',
        entity_id: 's1',
        payload: { sample_uid: 's1', visit_id: 'v1', lat: 47.9, lon: -103.2 },
      },
    ],
  };
}

function deps(sf: FakeSnowflake, blobs: MemoryBlobStore) {
  return {
    snowflake: sf.asClient(),
    blobs,
    tickets: new MediaTicketIssuer({
      blobs,
      baseUrl: 'https://example.test',
      uploadSecret: 'upload-secret',
    }),
    derivation: { async trigger() {} },
  };
}

describe('criterion 4 — replaying an accepted batch', () => {
  it('returns the same acknowledgement and writes nothing the second time', async () => {
    const sf = new FakeSnowflake();
    const blobs = new MemoryBlobStore();
    const request = batch();
    const rawBody = new TextEncoder().encode(JSON.stringify(request));

    const first = await handleSyncBatch(rawBody, request, deps(sf, blobs));
    expect([...first.accepted].sort()).toEqual(['s1', 'v1']);
    expect(first.rejected).toEqual([]);

    const mergesAfterFirst = sf.matching('MERGE INTO CURATED.').length;
    expect(mergesAfterFirst).toBeGreaterThan(0);

    const second = await handleSyncBatch(rawBody, request, deps(sf, blobs));

    expect(second.accepted).toEqual(first.accepted);
    expect(second.rejected).toEqual(first.rejected);
    expect(second.server_received_ts).toBe(first.server_received_ts);
    expect(second.raw_payload_hash).toBe(first.raw_payload_hash);

    // Nothing changed: no further statements of any kind.
    expect(sf.matching('MERGE INTO CURATED.').length).toBe(mergesAfterFirst);
  });

  it('hashes the bytes as received, not a re-serialisation', async () => {
    const sf = new FakeSnowflake();
    const blobs = new MemoryBlobStore();
    const request = batch();

    // Same object, different key order on the wire. The hash must follow the
    // bytes — otherwise RAW stops addressing what actually arrived.
    const reordered = new TextEncoder().encode(
      JSON.stringify({
        records: request.records,
        client_sent_ts: request.client_sent_ts,
        schema_version: request.schema_version,
        app_version: request.app_version,
        device_id: request.device_id,
        sync_batch_id: request.sync_batch_id,
      }),
    );

    const a = await handleSyncBatch(
      new TextEncoder().encode(JSON.stringify(request)),
      request,
      deps(sf, blobs),
    );
    const b = await handleSyncBatch(reordered, request, deps(new FakeSnowflake(), new MemoryBlobStore()));

    expect(a.raw_payload_hash).not.toBe(b.raw_payload_hash);
  });

  it('rejects one bad record without failing the batch', async () => {
    const sf = new FakeSnowflake();
    const blobs = new MemoryBlobStore();
    const request = batch();
    request.records.push({
      entity_type: 'sample_point',
      entity_id: 'mismatched',
      payload: { sample_uid: 'something-else' },
    });
    const rawBody = new TextEncoder().encode(JSON.stringify(request));

    const response = await handleSyncBatch(rawBody, request, deps(sf, blobs));

    expect([...response.accepted].sort()).toEqual(['s1', 'v1']);
    expect(response.rejected).toHaveLength(1);
    expect(response.rejected[0]!.entity_id).toBe('mismatched');
    expect(response.rejected[0]!.retryable).toBe(false);
  });

  it('marks a warehouse failure retryable rather than losing the records', async () => {
    const sf = new FakeSnowflake();
    const blobs = new MemoryBlobStore();
    const request = batch();
    const rawBody = new TextEncoder().encode(JSON.stringify(request));

    // RAW persist succeeds — the bytes are durable. The MERGE is what fails,
    // and that degrades to per-record retryable rejections rather than a lost
    // batch.
    sf.failWhen('MERGE INTO CURATED.FIELD_VISIT', new Error('warehouse suspended'));

    const response = await handleSyncBatch(rawBody, request, deps(sf, blobs));

    expect(response.rejected.some((r) => r.retryable && r.code === 'WAREHOUSE_UNAVAILABLE')).toBe(true);
    // The bytes are durable regardless — that is the point of step 1.
    expect(await blobs.head(`raw/sync/${response.raw_payload_hash}.json`)).not.toBeNull();
  });
});
