/**
 * A4 — `POST /v1/sync/batch`.
 *
 * A thin handler on purpose: it reads the **raw bytes** (the hash must address
 * what actually arrived, not a re-serialisation), wires dependencies, and hands
 * off. All the contract lives in `src/server/sync/batch.ts`, where it can be
 * tested without a network.
 */

import type { SyncBatchRequest } from '../../src/shared/contract/sync.js';
import { handleSyncBatch } from '../../src/server/sync/batch.js';
import { MediaTicketIssuer } from '../../src/server/media/tickets.js';
import { blobStore, snowflake, baseUrl, uploadSecret } from '../../src/server/env.js';

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const rawBody = new Uint8Array(await request.arrayBuffer());
  let parsed: SyncBatchRequest;
  try {
    parsed = JSON.parse(new TextDecoder().decode(rawBody)) as SyncBatchRequest;
  } catch {
    return json({ error: 'body is not valid JSON' }, 400);
  }

  if (!parsed.sync_batch_id || !Array.isArray(parsed.records)) {
    return json({ error: 'sync_batch_id and records are required' }, 400);
  }

  // The header is the contract's idempotency key; the body field is what the
  // rest of the pipeline uses. If both are present they must agree, or the
  // server's deduplication and the client's retry are keyed differently.
  const headerKey = request.headers.get('idempotency-key');
  if (headerKey && headerKey !== parsed.sync_batch_id) {
    return json({ error: 'Idempotency-Key does not match sync_batch_id' }, 400);
  }

  const blobs = await blobStore();
  const response = await handleSyncBatch(rawBody, parsed, {
    snowflake: snowflake(),
    blobs,
    tickets: new MediaTicketIssuer({
      blobs,
      baseUrl: baseUrl(),
      uploadSecret: uploadSecret(),
    }),
    derivation: {
      async trigger(syncBatchId) {
        // Background function, 15-minute ceiling. The payload is the id and
        // nothing else — the background cap is 256 KB and a batch is up to 2 MB.
        await fetch(new URL('/.netlify/functions/derive-batch-background', baseUrl()), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sync_batch_id: syncBatchId }),
        });
      },
    },
  });

  return json(response, 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
