/**
 * `wa-sqlite`'s own published types (`wa-sqlite/src/types/index.d.ts`) declare
 * `wa-sqlite`, `wa-sqlite/dist/*.mjs` and a handful of `src/examples/*.js`
 * modules — but not `OriginPrivateFileSystemVFS.js`, the OPFS VFS this driver
 * registers (see `wa-sqlite-opfs.ts` for why that one and not
 * `AccessHandlePoolVFS`). This is a minimal ambient stub, not a claim that the
 * class fully satisfies `SQLiteVFS` — the driver casts at the one call site
 * that needs it (`sqlite3.vfs_register`), the same way the library's own
 * examples are untyped JS underneath.
 */
declare module 'wa-sqlite/src/examples/OriginPrivateFileSystemVFS.js' {
  export class OriginPrivateFileSystemVFS {
    constructor();
    readonly name: string;
    close(): Promise<void>;
  }
}
