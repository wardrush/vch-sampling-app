/**
 * B1 — the real `SqlDatabase` implementation: `wa-sqlite` over OPFS.
 *
 * `src/shared/db/types.ts` (F0.6, `schema-steward`) defines the surface
 * everything else in the app codes against — `exec`/`run`/`all` — precisely so
 * that this file is the only one that knows wa-sqlite exists. Nothing above
 * this module touches the wasm module, the VFS, or a raw `db` pointer.
 *
 * **VFS choice: `OriginPrivateFileSystemVFS`, not `AccessHandlePoolVFS`.**
 * wa-sqlite ships two OPFS-backed VFS examples. `AccessHandlePoolVFS` is
 * faster but built on `FileSystemSyncAccessHandle`, which the spec (and every
 * shipping implementation) restricts to dedicated Worker threads — using it
 * from the main thread means standing up a Worker plus a Comlink-style RPC
 * proxy, and `comlink` is a devDependency of `wa-sqlite` itself, not a
 * dependency of this app (`SONNET_TASKS_STATUS.md`'s F0.3 install list).
 * Adding it is not this agent's call — dependencies are orchestrator-only.
 * `OriginPrivateFileSystemVFS` runs on the main thread today, using the async
 * (Asyncify) wasm build and regular `FileSystemFileHandle` read/write, which
 * is slower but correct and requires nothing else. If a Worker-hosted
 * `AccessHandlePoolVFS` is wanted for capture-day performance, that is a
 * follow-up with its own dependency ask, not a silent substitution here.
 *
 * **This is genuinely browser-only** — `navigator.storage.getDirectory()` does
 * not exist under Node or jsdom, so nothing here can run under `npm test`.
 * `device-db.ts` takes this as an injectable dependency for exactly that
 * reason: the migration/bootstrap *logic* is tested against
 * `tests/support/node-sqlite.ts`'s real-SQLite fake, and this file is
 * exercised by hand in a real browser, which is the honest boundary of what
 * this sandbox can verify (see the wave-1 report).
 */

import type { SqlDatabase, SqlValue } from '../../../shared/db/types.js';

/** The subset of the low-level `wa-sqlite` API this driver calls. */
interface SQLiteAPILike {
  vfs_register(vfs: unknown, makeDefault?: boolean): number;
  open_v2(zFilename: string, iFlags?: number, zVfs?: string): Promise<number>;
  close(db: number): Promise<number>;
  exec(
    db: number,
    zSQL: string,
    callback?: (row: unknown[], columns: string[]) => void,
  ): Promise<number>;
  run(db: number, zSQL: string, params?: SqlValue[]): Promise<number>;
  execWithParams(
    db: number,
    zSQL: string,
    params?: SqlValue[],
  ): Promise<{ rows: unknown[][]; columns: string[] }>;
}

function opfsSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.storage !== 'undefined' &&
    typeof navigator.storage.getDirectory === 'function'
  );
}

/** `SqlDatabase` backed by one open wa-sqlite connection. */
class WaSqliteDatabase implements SqlDatabase {
  constructor(
    private readonly sqlite3: SQLiteAPILike,
    private readonly handle: number,
  ) {}

  async exec(sql: string): Promise<void> {
    await this.sqlite3.exec(this.handle, sql);
  }

  async run(sql: string, params: SqlValue[] = []): Promise<void> {
    await this.sqlite3.run(this.handle, sql, params);
  }

  async all<T = Record<string, SqlValue>>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    const { rows, columns } = await this.sqlite3.execWithParams(this.handle, sql, params);
    return rows.map((row) => {
      const record: Record<string, unknown> = {};
      columns.forEach((col, i) => {
        record[col] = row[i] ?? null;
      });
      return record as T;
    });
  }

  async close(): Promise<void> {
    await this.sqlite3.close(this.handle);
  }
}

let connectionPromise: Promise<SqlDatabase> | null = null;

/**
 * Opens (or returns the cached) OPFS-backed device database connection.
 *
 * One connection for the app's lifetime — SQLite over a single-writer VFS
 * does not benefit from a pool, and a second connection to the same OPFS file
 * from the same tab is a lock-contention bug waiting to happen, not a
 * feature.
 */
export function openWaSqliteOpfsDatabase(filename = 'vch-sampler.sqlite3'): Promise<SqlDatabase> {
  if (!connectionPromise) {
    connectionPromise = createConnection(filename).catch((err) => {
      // A failed open must not poison future attempts (e.g. a transient OPFS
      // lock held by a since-closed tab) — clear the cache so the next caller
      // gets a fresh try rather than a permanently-rejected promise.
      connectionPromise = null;
      throw err;
    });
  }
  return connectionPromise;
}

async function createConnection(filename: string): Promise<SqlDatabase> {
  if (!opfsSupported()) {
    throw new Error(
      'OPFS is not available in this browser (navigator.storage.getDirectory is missing). ' +
        'The sampler needs a browser with Origin Private File System support (recent Chrome/Edge/Android WebView).',
    );
  }

  // Dynamic imports: this whole module is dead weight on any render path that
  // never opens the database (there isn't one in this app, but it also keeps
  // the multi-MB wasm binary out of the initial bundle graph analysis).
  const [{ default: ModuleFactory }, { Factory }, { OriginPrivateFileSystemVFS }] =
    await Promise.all([
      import('wa-sqlite/dist/wa-sqlite-async.mjs'),
      import('wa-sqlite'),
      import('wa-sqlite/src/examples/OriginPrivateFileSystemVFS.js'),
    ]);

  const module = await ModuleFactory();
  const sqlite3 = Factory(module) as unknown as SQLiteAPILike;

  const vfs = new OriginPrivateFileSystemVFS();
  sqlite3.vfs_register(vfs, true);

  const handle = await sqlite3.open_v2(filename, undefined, vfs.name);
  return new WaSqliteDatabase(sqlite3, handle);
}

/** Test/dev escape hatch — never called from app code. */
export function _resetConnectionForTests(): void {
  connectionPromise = null;
}
