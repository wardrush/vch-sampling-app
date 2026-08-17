/**
 * A5 — the MVP media upload path.
 *
 * Netlify Blobs has **no direct browser upload**: bytes must transit a
 * function. At ~400 KB a photo encodes well inside the ~4.5 MB effective
 * binary limit, so this is comfortable — and it is the one genuinely
 * Netlify-shaped constraint in the build.
 *
 * The URL that reaches the phone is signed and short-lived, so this endpoint is
 * not an open write surface. On the S3/R2 path the same signature is computed
 * by the object store instead; **the client does not change**, which is the
 * whole reason the ticket carries a URL rather than a provider.
 */

import { createHash } from 'node:crypto';
import { verifyUploadGrant } from '../../src/server/media/tickets.js';
import { mediaKey } from '../../src/server/storage/blobs.js';
import { blobStore, uploadSecret } from '../../src/server/env.js';

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST' && request.method !== 'PUT') {
    return new Response('method not allowed', { status: 405 });
  }

  const url = new URL(request.url);
  const mediaId = url.searchParams.get('media_id');
  const contentHash = url.searchParams.get('content_hash');
  const expires = Number(url.searchParams.get('expires'));
  const grant = url.searchParams.get('grant');

  if (!mediaId || !contentHash || !grant || !Number.isFinite(expires)) {
    return new Response('malformed ticket', { status: 400 });
  }
  if (!verifyUploadGrant(uploadSecret(), mediaId, contentHash, expires, grant, Date.now())) {
    // Expired and forged are answered identically. A client that let a ticket
    // expire retries the batch and gets a fresh one, so it needs no detail.
    return new Response('ticket rejected', { status: 403 });
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) return new Response('empty body', { status: 400 });

  // Verify before storing, not after. Storing unverified bytes under a
  // content-addressed key would make the key a lie.
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== contentHash) {
    return new Response(
      JSON.stringify({ code: 'HASH_MISMATCH', detail: `received bytes hash to ${actual}` }),
      { status: 422, headers: { 'content-type': 'application/json' } },
    );
  }

  const blobs = await blobStore();
  await blobs.put(mediaKey(contentHash), bytes, { media_id: mediaId });

  return new Response(JSON.stringify({ media_id: mediaId, bytes: bytes.byteLength }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
