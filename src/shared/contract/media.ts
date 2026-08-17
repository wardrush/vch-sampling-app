/**
 * Up-sync: media. SYNC_CONTRACT_v01 §4, amended by addendum §4.1.
 *
 * **The seam.** A ticket contains *a URL*. The client neither knows nor cares
 * what is behind it: a Netlify Function today, an S3/R2 presigned PUT after
 * the pilot proves volume. Keeping that opaque is what makes the swap a
 * server-side change rather than a client rewrite — so nothing in this file
 * names a storage provider, and nothing should.
 */

import type { ContentHash, IsoTimestamp, Uuid7 } from './common.js';

/** The hash is already known to the server; not one byte need move. */
export interface MediaTicketAlreadyHave {
  media_id: Uuid7;
  content_hash: ContentHash;
  action: 'already_have';
}

export interface MediaTicketUpload {
  media_id: Uuid7;
  content_hash: ContentHash;
  action: 'upload';
  /** Opaque. Do not parse it, do not branch on its host. */
  url: string;
  /** `POST` multipart on the MVP function path, `PUT` on a presigned URL. */
  method: 'POST' | 'PUT';
  /** Sent verbatim with the upload. Carries the MVP path's auth. */
  headers?: Record<string, string>;
  expires_ts: IsoTimestamp;
  /**
   * Advisory. The MVP function path is not resumable — a drop at 80% restarts.
   * Tolerable at ~400 KB, and one more reason the swap happens before volume.
   */
  resumable?: boolean;
}

export type MediaTicket = MediaTicketAlreadyHave | MediaTicketUpload;

export function isUploadTicket(t: MediaTicket): t is MediaTicketUpload {
  return t.action === 'upload';
}

/** `POST /v1/sync/media/commit` */
export interface MediaCommitRequest {
  media_id: Uuid7;
  content_hash: ContentHash;
  bytes: number;
}

/**
 * A hash mismatch **fails the commit and the client re-uploads**. The
 * alternative is a silently corrupt photograph, discovered by an analyst in
 * April.
 */
export interface MediaCommitResponse {
  media_id: Uuid7;
  upload_state: 'uploaded' | 'failed';
  verified: boolean;
  code?: 'HASH_MISMATCH' | 'OBJECT_MISSING' | 'BYTES_MISMATCH';
  detail?: string;
  retryable?: boolean;
}
