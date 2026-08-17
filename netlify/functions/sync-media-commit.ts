/**
 * A5 — `POST /v1/sync/media/commit`. Contract §4 step 4.
 *
 * Verifies the stored object against the claimed hash and only then sets
 * `UPLOAD_STATE = 'uploaded'`. A mismatch fails the commit and the client
 * re-uploads; the alternative is a silently corrupt photograph, discovered by
 * an analyst in April.
 */

import type { MediaCommitRequest } from '../../src/shared/contract/media.js';
import { commitMedia } from '../../src/server/media/tickets.js';
import { syntaxFor } from '../../src/server/sync/dialect.js';
import { blobStore, sqlClient } from '../../src/server/env.js';

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });

  let body: MediaCommitRequest;
  try {
    body = (await request.json()) as MediaCommitRequest;
  } catch {
    return json({ error: 'body is not valid JSON' }, 400);
  }
  if (!body.media_id || !body.content_hash) {
    return json({ error: 'media_id and content_hash are required' }, 400);
  }

  const sf = sqlClient();
  const syntax = syntaxFor(sf);
  const result = await commitMedia(body, {
    blobs: await blobStore(),
    async markUploaded(mediaId, hash, key, bytes) {
      // `RAW.MEDIA_UPLOAD_LOG` is append-only on both backends: a re-upload
      // appends a second row rather than upserting, which is the record of what
      // actually happened to the bytes.
      await sf.executeMulti(
        [
          `UPDATE CURATED.MEDIA
              SET UPLOAD_STATE = 'uploaded', UPLOADED_TS = ${syntax.now},
                  OBJECT_KEY = ?, BYTES = ?, LAST_UPDATED_TS = ${syntax.now}
            WHERE MEDIA_ID = ?`,
          `INSERT INTO RAW.MEDIA_UPLOAD_LOG
             (CONTENT_HASH, MEDIA_ID, OBJECT_KEY, BYTES, UPLOAD_COMPLETED_TS, UPLOAD_STATE)
           SELECT ?, ?, ?, ?, ${syntax.now}, 'uploaded'`,
        ],
        { binds: [key, bytes, mediaId, hash, mediaId, key, bytes] },
      );
    },
  });

  // A failed verification is a 422 the client acts on, not a 500 it retries
  // blindly — the bytes need re-sending, and only the client can do that.
  return json(result, result.upload_state === 'uploaded' ? 200 : 422);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
