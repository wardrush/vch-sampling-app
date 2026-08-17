/**
 * B1 — the real `SqlDatabase` implementation: `wa-sqlite` in the tab's main
 * thread, backed first by IndexedDB and, only if that fails, by memory.
 *
 * **This file's name is a leftover from a design that shipped broken — see
 * below — and is being kept as-is because that is the exact file the
 * incident named. `IDBBatchAtomicVFS`/`MemoryAsyncVFS`, not OPFS, are what
 * this module actually opens now. A future pass should rename it; nothing
 * downstream should infer OPFS from the filename in the meantime.**
 *
 * ## What was wrong, verified in a real browser against the production bundle
 *
 * Every screen was showing "Device database unavailable: unable to open
 * database file". The console carried the real reason:
 * `e.fileHandle.createSyncAccessHandle is not a function`. This module used
 * to register `OriginPrivateFileSystemVFS` (`wa-sqlite/src/examples/`), and
 * that VFS calls `FileSystemSyncAccessHandle.createSyncAccessHandle` — an API
 * the spec (and every shipping browser) restricts to a dedicated Worker
 * thread. Called from the main thread, as this module always did,
 * `open_v2()` can only return `SQLITE_CANTOPEN`. The previous version of
 * this file's own header claimed the opposite — that
 * `OriginPrivateFileSystemVFS` "runs on the main thread today, using regular
 * `FileSystemFileHandle` read/write". That was false for the version of
 * `wa-sqlite` actually installed (`grep -c createSyncAccessHandle
 * node_modules/wa-sqlite/src/examples/OriginPrivateFileSystemVFS.js` → `1`),
 * and it is the reason the bug shipped: the comment told the next reader the
 * file was safe.
 *
 * OPFS itself is fine — `navigator.storage.getDirectory()` works, a file can
 * be created/written/read back — so this was never a COOP/COEP problem, a
 * wasm-loading problem, a quota problem, or an iOS-only problem. Standing up
 * a Worker plus an RPC layer to use `AccessHandlePoolVFS` correctly would
 * have fixed it, but `comlink` (the RPC library `wa-sqlite`'s own examples
 * use) is a devDependency of `wa-sqlite`, not of this app, and adding a
 * dependency is orchestrator-only here — see the previous version of this
 * file for that reasoning, which still holds.
 *
 * ## What this version does instead
 *
 * `IDBBatchAtomicVFS` (`wa-sqlite/src/examples/IDBBatchAtomicVFS.js`, `grep -c
 * createSyncAccessHandle` → `0`) stores pages in IndexedDB, needs nothing
 * from a Worker, and is durable across reloads — the same persistence
 * guarantee OPFS would have given, through an API every target browser
 * (including Safari, D4: "Android first, iOS parity from day one") supports
 * without the sync-handle restriction. It is the primary path.
 *
 * If IndexedDB itself is unavailable (private-browsing quirks, an exhausted
 * quota, a genuinely broken host) this module falls back to
 * `MemoryAsyncVFS` (`wa-sqlite/src/examples/MemoryAsyncVFS.js`, also `0`
 * uses) — pure JS, no browser storage API at all, so it is the one VFS that
 * can be trusted to open. **The app must never hard-fail again**, so this is
 * the last resort, not an error. What it is *not* is persistent: anything
 * captured while running on it is gone the moment the tab closes.
 * `WaSqliteDatabase.backend` carries which VFS actually won so
 * `device-db.ts`/`DeviceDbProvider` can say so honestly on screen (see
 * `MemoryFallbackBanner.tsx`) — a sampler must never be left believing a
 * day's work is stored when it is not, which is the same principle the
 * Outbox screen exists for.
 *
 * **This is genuinely browser-only** — neither IndexedDB nor a network-hosted
 * wasm module reliably resolve under Node/jsdom (confirmed: even the
 * dependency-free `MemoryAsyncVFS` path fails there, because the wasm loader
 * itself calls `fetch()` on a `file://` module URL, which Node's `fetch`
 * refuses) — so nothing here can run under `npm test`. `device-db.ts` takes
 * this as an injectable dependency for exactly that reason: the
 * migration/bootstrap *logic* is tested against `tests/support/node-sqlite.ts`'s
 * real-SQLite fake, and this file is exercised for real by
 * `tests/e2e/**` (Playwright, a real Chromium) — see that suite for the
 * verification a unit test cannot give.
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

/** Which VFS actually answered `open_v2()`. Only `'idb'` survives a reload. */
export type WaSqliteBackend = 'idb' | 'memory';

/** The name shared by the sqlite VFS registration and the underlying
 *  IndexedDB database `IDBBatchAtomicVFS` opens — see that file's own
 *  constructor: the string doubles as both. Distinct from the sqlite
 *  "filename" (`vch-sampler.sqlite3`) passed to `open_v2`. */
const IDB_VFS_NAME = 'vch-sampler-idb';

/**
 * `SqlDatabase` backed by one open wa-sqlite connection.
 *
 * **Every call is serialized through `schedule()`, deliberately.** This is
 * the async (Asyncify) build: a single low-level call unwinds and rewinds
 * one wasm coroutine across however many awaited VFS operations it needs,
 * and that mechanism assumes exactly one call is ever in flight on a given
 * connection. `SqlDatabase.exec/run/all` promise nothing about that to
 * callers — and the app has several call sites that reasonably read as
 * independent, parallel queries (`Promise.all([listBoundarySummaries(db),
 * new OutboxStore(db).counts()])` in `TodayScreen`, five queries at once in
 * `CaptureScreen`'s load effect). Two such calls racing on the same
 * connection reliably corrupted VFS-internal state once the database held
 * enough real data to need more than a single-page read to answer either
 * one — verified directly: instrumenting every `exec`/`run`/`all` call
 * showed the crash always land on the *second* of two concurrently-issued
 * statements, never on a lone one, and reopening a large real (post-bundle,
 * post-capture) database with two concurrent Today-screen queries reproduced
 * "unable to open database file" (a wasm-level "memory access out of
 * bounds" and "Cannot read properties of undefined (reading 'data')" inside
 * `IDBBatchAtomicVFS`, both first surfacing on the second statement) on
 * every single attempt. A FIFO queue here is cheaper and less invasive than
 * auditing and serializing every current and future caller across the app,
 * and it is exactly the kind of thing "the one module that knows wa-sqlite
 * exists" (this file's original framing) should own on callers' behalf.
 */
class WaSqliteDatabase implements SqlDatabase {
  /** Chained so each call starts only after the previous one has fully
   *  settled — success or failure, never left half-run. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly sqlite3: SQLiteAPILike,
    private readonly handle: number,
    /** Extra to the `SqlDatabase` contract on purpose — see this file's
     *  header. Nothing that only knows `SqlDatabase` can see it; `device-db.ts`
     *  reads it with a runtime duck-type check to populate `DeviceDbHandle.backend`. */
    readonly backend: WaSqliteBackend,
  ) {}

  private schedule<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    // The queue itself must never reject — a failed statement must not wedge
    // every statement queued behind it — so the tail we chain onto swallows
    // the outcome. `result`, returned to the caller, still carries it.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async exec(sql: string): Promise<void> {
    await this.schedule(() => this.sqlite3.exec(this.handle, sql));
  }

  async run(sql: string, params: SqlValue[] = []): Promise<void> {
    await this.schedule(() => this.sqlite3.run(this.handle, sql, params));
  }

  async all<T = Record<string, SqlValue>>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    return this.schedule(async () => {
      const { rows, columns } = await this.sqlite3.execWithParams(this.handle, sql, params);
      return rows.map((row) => {
        const record: Record<string, unknown> = {};
        columns.forEach((col, i) => {
          record[col] = row[i] ?? null;
        });
        return record as T;
      });
    });
  }

  async close(): Promise<void> {
    await this.schedule(() => this.sqlite3.close(this.handle));
  }
}

let connectionPromise: Promise<SqlDatabase> | null = null;

/**
 * Opens (or returns the cached) IndexedDB-backed device database connection
 * — or the in-memory fallback if that fails. See this file's header.
 *
 * One connection for the app's lifetime — SQLite over a single-writer VFS
 * does not benefit from a pool, and a second connection to the same
 * underlying store from the same tab is a lock-contention bug waiting to
 * happen, not a feature.
 */
export function openWaSqliteOpfsDatabase(filename = 'vch-sampler.sqlite3'): Promise<SqlDatabase> {
  if (!connectionPromise) {
    connectionPromise = createConnection(filename).catch((err) => {
      // A failed open must not poison future attempts (e.g. a transient lock
      // held by a since-closed tab) — clear the cache so the next caller
      // gets a fresh try rather than a permanently-rejected promise.
      connectionPromise = null;
      throw err;
    });
  }
  return connectionPromise;
}

async function createConnection(filename: string): Promise<SqlDatabase> {
  const sqlite3 = await loadSqliteEngine();

  try {
    const { IDBBatchAtomicVFS } = await import('wa-sqlite/src/examples/IDBBatchAtomicVFS.js');
    return await openWithVfs(sqlite3, filename, new IDBBatchAtomicVFS(IDB_VFS_NAME), 'idb');
  } catch (idbErr) {
    // Not the app's own console.error suppression policy to invent here —
    // this is exactly the failure a field crew must never see silently
    // succeed as "saved". Loud on purpose.
    // eslint-disable-next-line no-console
    console.error(
      '[device-db] Persistent (IndexedDB) database unavailable — falling back to an ' +
        'in-memory database. Nothing captured on this device will survive this tab closing ' +
        'until that changes. DeviceDbProvider/MemoryFallbackBanner surface this on every screen.',
      idbErr,
    );
  }

  try {
    const { MemoryAsyncVFS } = await import('wa-sqlite/src/examples/MemoryAsyncVFS.js');
    return await openWithVfs(sqlite3, filename, new MemoryAsyncVFS(), 'memory');
  } catch (memErr) {
    // Both the durable path and the dependency-free last resort failed —
    // there is nothing further to fall back to. Surface both causes.
    throw new Error(
      `The sampler could not open a local database by any available method ` +
        `(IndexedDB or in-memory) in this browser. (${errMessage(memErr)})`,
    );
  }
}

async function openWithVfs(
  sqlite3: SQLiteAPILike,
  filename: string,
  vfs: { name: string },
  backend: WaSqliteBackend,
): Promise<SqlDatabase> {
  sqlite3.vfs_register(vfs, true);
  const handle = await sqlite3.open_v2(filename, undefined, vfs.name);
  return new WaSqliteDatabase(sqlite3, handle, backend);
}

/**
 * Loads the wasm engine. Dynamic imports: dead weight on any render path
 * that never opens the database (there isn't one in this app, but it also
 * keeps the multi-MB wasm binary out of the initial bundle graph analysis).
 *
 * Failures here are given one clear, honest message rather than whatever
 * `fetch`/wasm-compile error the platform happened to throw — but they are
 * **not** relabelled as an unsupported browser unless the underlying cause
 * actually is one; a network hiccup mid-load gets its own message via
 * `errMessage`, not a false "your browser can't do this".
 */
async function loadSqliteEngine(): Promise<SQLiteAPILike> {
  try {
    const [{ default: ModuleFactory }, { Factory }] = await Promise.all([
      import('wa-sqlite/dist/wa-sqlite-async.mjs'),
      import('wa-sqlite'),
    ]);
    const module = await ModuleFactory();
    return Factory(module) as unknown as SQLiteAPILike;
  } catch (err) {
    throw new Error(
      `Could not load the sampler's local database engine (WebAssembly) in this browser. ` +
        `Use a recent version of Chrome, Edge, Safari, or Android WebView. (${errMessage(err)})`,
    );
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Test/dev escape hatch — never called from app code. */
export function _resetConnectionForTests(): void {
  connectionPromise = null;
}
