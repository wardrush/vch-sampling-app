/**
 * A5 — media tickets. Contract §4, addendum §4.1.
 *
 * Two phases, so the same photo is never uploaded twice and a half-uploaded
 * photo never becomes a half-record:
 *
 *  1. Metadata rides in the record batch. The server answers with a ticket per
 *     media item — `already_have` when the content hash is known, `upload`
 *     otherwise.
 *  2. The client sends the bytes to the ticket's URL, then commits. The commit
 *     verifies the stored bytes against the hash; **a mismatch fails the commit
 *     and the client re-uploads.** The alternative is a silently corrupt
 *     photograph discovered by an analyst in April.
 *
 * `already_have` matters more under Netlify than it did on paper: every avoided
 * upload is avoided function bandwidth. Duplicate label photos across a crew
 * cost nothing.
 *
 * **The URL is opaque to the client.** Today it is a function; after the pilot
 * it is a presigned PUT. Nothing here leaks which, and nothing should.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { ContentHash, IsoTimestamp } from '../../shared/contract/common.js';
import type {
  MediaCommitRequest,
  MediaCommitResponse,
  MediaTicket,
} from '../../shared/contract/media.js';
import type { MediaMetaPayload } from '../../shared/contract/entities.js';
import { type BlobStore, mediaKey } from '../storage/blobs.js';

/** Ticket validity. Long enough for a crew to reach signal, short enough to matter. */
const TICKET_TTL_MS = 24 * 60 * 60 * 1000;

export interface TicketIssuerOptions {
  blobs: BlobStore;
  /** Absolute base URL of the deployment, e.g. `https://vch-sampling.netlify.app`. */
  baseUrl: string;
  /** Signs the upload grant. Separate from the session secret. */
  uploadSecret: string;
  now?: () => number;
}

export function normaliseHash(hash: string): string {
  return hash.startsWith('sha256:') ? hash.slice(7) : hash;
}

export function prefixHash(hash: string): ContentHash {
  return (hash.startsWith('sha256:') ? hash : `sha256:${hash}`) as ContentHash;
}

/**
 * A short-lived HMAC over `media_id|hash|expiry`.
 *
 * The upload function accepts bytes only with a matching grant, so the endpoint
 * is not an open write surface even though the URL travels to a phone. On the
 * S3/R2 path this is exactly what the presigned signature does, which is the
 * point: the two paths differ in who computes the signature, not in the shape.
 */
export function signUploadGrant(
  secret: string,
  mediaId: string,
  contentHash: string,
  expiresAtMs: number,
): string {
  return createHmac('sha256', secret)
    .update(`${mediaId}|${normaliseHash(contentHash)}|${expiresAtMs}`)
    .digest('base64url');
}

export function verifyUploadGrant(
  secret: string,
  mediaId: string,
  contentHash: string,
  expiresAtMs: number,
  grant: string,
  nowMs: number,
): boolean {
  if (!Number.isFinite(expiresAtMs) || nowMs > expiresAtMs) return false;
  const expected = Buffer.from(signUploadGrant(secret, mediaId, contentHash, expiresAtMs));
  const actual = Buffer.from(grant);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export class MediaTicketIssuer {
  private readonly now: () => number;

  constructor(private readonly options: TicketIssuerOptions) {
    this.now = options.now ?? Date.now;
  }

  /**
   * One ticket per media record in the batch.
   *
   * Deduplicates within the batch too: a crew photographing the same printed
   * label twice in one visit gets one upload, not two.
   */
  async issue(media: readonly MediaMetaPayload[]): Promise<MediaTicket[]> {
    const tickets: MediaTicket[] = [];
    const issuedHashes = new Set<string>();

    for (const item of media) {
      const hash = normaliseHash(item.content_hash);
      const existing = await this.options.blobs.head(mediaKey(hash));

      if (existing || issuedHashes.has(hash)) {
        tickets.push({
          media_id: item.media_id,
          content_hash: prefixHash(hash),
          action: 'already_have',
        });
        continue;
      }

      const expiresAtMs = this.now() + TICKET_TTL_MS;
      const grant = signUploadGrant(this.options.uploadSecret, item.media_id, hash, expiresAtMs);
      const url = new URL('/.netlify/functions/sync-media-upload', this.options.baseUrl);
      url.searchParams.set('media_id', item.media_id);
      url.searchParams.set('content_hash', hash);
      url.searchParams.set('expires', String(expiresAtMs));
      url.searchParams.set('grant', grant);

      tickets.push({
        media_id: item.media_id,
        content_hash: prefixHash(hash),
        action: 'upload',
        url: url.toString(),
        method: 'POST',
        expires_ts: new Date(expiresAtMs).toISOString() as IsoTimestamp,
        // The MVP function path is not resumable — a drop at 80% restarts.
        // Tolerable at ~400 KB; the client's retry logic is identical either
        // way, so nothing needs writing twice when this becomes true.
        resumable: false,
      });
      issuedHashes.add(hash);
    }
    return tickets;
  }
}

export interface MediaCommitDeps {
  blobs: BlobStore;
  /** Flips `UPLOAD_STATE` and stamps `UPLOADED_TS` / `OBJECT_KEY`. */
  markUploaded(mediaId: string, hash: string, key: string, bytes: number): Promise<void>;
  now?: () => number;
}

/**
 * `POST /v1/sync/media/commit`.
 *
 * Verifies the stored object against the claimed hash before anything is
 * marked uploaded. This is the only place in the media path where a check can
 * catch corruption, so it is not optional and it is not sampled.
 */
export async function commitMedia(
  request: MediaCommitRequest,
  deps: MediaCommitDeps,
): Promise<MediaCommitResponse> {
  const hash = normaliseHash(request.content_hash);
  const key = mediaKey(hash);
  const stored = await deps.blobs.get(key);

  if (!stored) {
    return {
      media_id: request.media_id,
      upload_state: 'failed',
      verified: false,
      code: 'OBJECT_MISSING',
      detail: 'no object stored under this content hash',
      retryable: true,
    };
  }

  const actual = createHash('sha256').update(stored).digest('hex');
  if (actual !== hash) {
    return {
      media_id: request.media_id,
      upload_state: 'failed',
      verified: false,
      code: 'HASH_MISMATCH',
      detail: `stored bytes hash to ${actual}`,
      retryable: true,
    };
  }

  if (stored.byteLength !== request.bytes) {
    // The hash already matched, so the bytes are right and the *claim* is
    // wrong. Worth surfacing — it means a client counted wrong — but not worth
    // failing the photo over.
    return {
      media_id: request.media_id,
      upload_state: 'failed',
      verified: true,
      code: 'BYTES_MISMATCH',
      detail: `stored ${stored.byteLength} bytes, client claimed ${request.bytes}`,
      retryable: true,
    };
  }

  await deps.markUploaded(request.media_id, hash, key, stored.byteLength);
  return { media_id: request.media_id, upload_state: 'uploaded', verified: true };
}
