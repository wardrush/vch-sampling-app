/**
 * Object storage, behind an interface.
 *
 * Netlify Blobs today; S3/R2 after the pilot proves volume. The swap is a
 * server-side change because nothing above this file names a provider — the
 * same discipline the media *ticket* enforces on the client side.
 */

export interface StoredObject {
  key: string;
  bytes: number;
}

export interface BlobStore {
  put(key: string, data: Uint8Array, meta?: Record<string, string>): Promise<StoredObject>;
  get(key: string): Promise<Uint8Array | null>;
  head(key: string): Promise<StoredObject | null>;
}

/** Content-addressed keys. The hash *is* the identity; nothing else is. */
export function rawPayloadKey(hash: string): string {
  return `raw/sync/${hash}.json`;
}

export function mediaKey(hash: string): string {
  return `media/${hash}`;
}

export function importFileKey(hash: string): string {
  return `raw/import/${hash}`;
}

/** In-memory store. Tests and `netlify dev` without a Blobs binding. */
export class MemoryBlobStore implements BlobStore {
  private readonly objects = new Map<string, Uint8Array>();

  async put(key: string, data: Uint8Array): Promise<StoredObject> {
    this.objects.set(key, data);
    return { key, bytes: data.byteLength };
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.objects.get(key) ?? null;
  }

  async head(key: string): Promise<StoredObject | null> {
    const data = this.objects.get(key);
    return data ? { key, bytes: data.byteLength } : null;
  }
}
