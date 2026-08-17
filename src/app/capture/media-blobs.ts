/**
 * Where photograph bytes live on the device.
 *
 * `device_sqlite_v01.sql` is explicit about this: the `media` table is
 * metadata only and the bytes sit in OPFS at `media/<content_hash>.jpg`.
 * Blobs in SQLite would put 400 KB of JPEG inside every row the sync worker
 * reads, and the row it reads is 800 bytes of metadata.
 *
 * Two properties this store has to have, both for reasons that only show up
 * later:
 *
 *  - **Content-addressed.** The name of the file is the SHA-256 the media row
 *    carries and the upload ticket is issued against. Two identical
 *    photographs are one object, and a byte that changed on disk stops
 *    matching its own name.
 *  - **Bytes land before the row does.** `CaptureSession` writes here at the
 *    moment of capture, not at save. A media row whose bytes never arrived is
 *    a photograph that can never upload; a blob with no row is fifty
 *    kilobytes of garbage the Storage screen can reclaim. The second failure
 *    is the survivable one, so it is the one the ordering chooses.
 *
 * There is deliberately **no silent in-memory fallback** in the browser path.
 * A store that quietly kept photographs in RAM would lose a day's evidence at
 * the next tab discard and report nothing; `MemoryMediaBlobStore` exists for
 * tests and says so in its name.
 */

export interface MediaBlobStore {
  /** Returns the `media.local_path` to record. Idempotent on the hash. */
  put(contentHash: string, bytes: Uint8Array): Promise<string>;
  read(contentHash: string): Promise<Uint8Array | null>;
  has(contentHash: string): Promise<boolean>;
  /** Explicit reclaim only — never called as part of sync (v02 §3). */
  remove(contentHash: string): Promise<void>;
  /** Content hashes currently held. Feeds the Storage screen. */
  list(): Promise<string[]>;
  usageBytes(): Promise<number>;
}

export const MEDIA_DIR = 'media';

export function mediaLocalPath(contentHash: string): string {
  return `${MEDIA_DIR}/${contentHash}.jpg`;
}

/**
 * OPFS. The v1 PWA store.
 *
 * `createWritable` is used rather than `createSyncAccessHandle` because the
 * latter is worker-only; the capture screen runs on the main thread. If a
 * platform ships OPFS without `createWritable`, this throws rather than
 * degrading — see the header.
 */
export class OpfsMediaBlobStore implements MediaBlobStore {
  private dir: Promise<FileSystemDirectoryHandle> | null = null;

  constructor(private readonly storage: StorageManager | undefined = globalThis.navigator?.storage) {}

  private directory(): Promise<FileSystemDirectoryHandle> {
    if (!this.dir) {
      const storage = this.storage;
      if (!storage || typeof storage.getDirectory !== 'function') {
        return Promise.reject(new Error('OPFS unavailable: navigator.storage.getDirectory is missing'));
      }
      this.dir = storage
        .getDirectory()
        .then((root) => root.getDirectoryHandle(MEDIA_DIR, { create: true }));
    }
    return this.dir;
  }

  async put(contentHash: string, bytes: Uint8Array): Promise<string> {
    const dir = await this.directory();
    const handle = await dir.getFileHandle(`${contentHash}.jpg`, { create: true });
    const existing = await handle.getFile();
    // Same name means same bytes — that is what content addressing buys.
    if (existing.size === bytes.byteLength && existing.size > 0) return mediaLocalPath(contentHash);
    if (typeof handle.createWritable !== 'function') {
      throw new Error('OPFS unavailable: FileSystemFileHandle.createWritable is missing');
    }
    const writable = await handle.createWritable();
    await writable.write(bytes as unknown as BufferSource);
    await writable.close();
    return mediaLocalPath(contentHash);
  }

  async read(contentHash: string): Promise<Uint8Array | null> {
    try {
      const dir = await this.directory();
      const handle = await dir.getFileHandle(`${contentHash}.jpg`);
      const file = await handle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      return null;
    }
  }

  async has(contentHash: string): Promise<boolean> {
    try {
      const dir = await this.directory();
      await dir.getFileHandle(`${contentHash}.jpg`);
      return true;
    } catch {
      return false;
    }
  }

  async remove(contentHash: string): Promise<void> {
    try {
      const dir = await this.directory();
      await dir.removeEntry(`${contentHash}.jpg`);
    } catch {
      /* already gone is the desired end state */
    }
  }

  async list(): Promise<string[]> {
    const dir = await this.directory();
    const out: string[] = [];
    for await (const name of directoryKeys(dir)) {
      if (name.endsWith('.jpg')) out.push(name.slice(0, -4));
    }
    return out;
  }

  async usageBytes(): Promise<number> {
    const dir = await this.directory();
    let total = 0;
    for await (const name of directoryKeys(dir)) {
      const handle = await dir.getFileHandle(name);
      total += (await handle.getFile()).size;
    }
    return total;
  }
}

/** Test double. Named so nobody ships it by accident. */
export class MemoryMediaBlobStore implements MediaBlobStore {
  private readonly blobs = new Map<string, Uint8Array>();

  async put(contentHash: string, bytes: Uint8Array): Promise<string> {
    this.blobs.set(contentHash, bytes);
    return mediaLocalPath(contentHash);
  }

  async read(contentHash: string): Promise<Uint8Array | null> {
    return this.blobs.get(contentHash) ?? null;
  }

  async has(contentHash: string): Promise<boolean> {
    return this.blobs.has(contentHash);
  }

  async remove(contentHash: string): Promise<void> {
    this.blobs.delete(contentHash);
  }

  async list(): Promise<string[]> {
    return [...this.blobs.keys()];
  }

  async usageBytes(): Promise<number> {
    let total = 0;
    for (const bytes of this.blobs.values()) total += bytes.byteLength;
    return total;
  }
}

/**
 * A preview URL for a tile. The caller owns revoking it.
 *
 * Returns null where `URL.createObjectURL` does not exist (Node under test),
 * so a screen's tile logic is the same in both places.
 */
export function objectUrlFor(bytes: Uint8Array, mimeType = 'image/jpeg'): string | null {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
  return URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mimeType }));
}

export function revokeObjectUrl(url: string | null): void {
  if (!url) return;
  if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return;
  URL.revokeObjectURL(url);
}

/** `FileSystemDirectoryHandle.keys()` is async-iterable but not in every lib.dom. */
async function* directoryKeys(dir: FileSystemDirectoryHandle): AsyncGenerator<string> {
  const iterable = (dir as unknown as { keys?: () => AsyncIterableIterator<string> }).keys;
  if (typeof iterable !== 'function') return;
  for await (const name of iterable.call(dir)) yield name;
}
