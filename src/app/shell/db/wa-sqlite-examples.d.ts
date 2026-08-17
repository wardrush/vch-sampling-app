/**
 * `wa-sqlite`'s own published types (`wa-sqlite/src/types/index.d.ts`) declare
 * `wa-sqlite`, `wa-sqlite/dist/*.mjs`, `MemoryAsyncVFS.js` and a handful of
 * other `src/examples/*.js` modules — but not `IDBBatchAtomicVFS.js`, the
 * IndexedDB-backed VFS this driver registers as its primary backend (see
 * `wa-sqlite-opfs.ts`'s header for the incident that led here and why this
 * one, not `OriginPrivateFileSystemVFS`/`AccessHandlePoolVFS`). This is a
 * minimal ambient stub, not a claim that the class fully satisfies
 * `SQLiteVFS` — the driver casts at the one call site that needs it
 * (`sqlite3.vfs_register`), the same way the library's own examples are
 * untyped JS underneath.
 */
declare module 'wa-sqlite/src/examples/IDBBatchAtomicVFS.js' {
  export interface IDBBatchAtomicVFSOptions {
    durability?: 'default' | 'strict' | 'relaxed';
    purge?: 'deferred' | 'manual';
    purgeAtLeast?: number;
  }

  export class IDBBatchAtomicVFS {
    /**
     * @param idbDatabaseName Doubles as both the sqlite VFS name and the
     *   underlying IndexedDB database name — see the class's own source.
     */
    constructor(idbDatabaseName?: string, options?: IDBBatchAtomicVFSOptions);
    readonly name: string;
    close(): Promise<void>;
  }
}
