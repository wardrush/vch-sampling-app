/**
 * Runtime configuration, read once per cold start.
 *
 * Every secret is required explicitly and fails loudly at boot rather than
 * defaulting to something that half-works. A function that silently signs
 * sessions with `undefined` is worse than one that will not start.
 *
 * **That property is per backend now, not global.** Selecting Postgres must not
 * require Snowflake variables, and selecting Snowflake must still fail loudly
 * without them. `sqlBackend()` decides which set is required; each factory
 * requires only its own.
 */

import { SnowflakeClient, type SnowflakeConfig } from '../shared/snowflake/client.js';
import type { SqlClient } from '../shared/db/port.js';
import { PostgresClient } from '../shared/db/postgres/client.js';
import { neonHttpExecutor } from '../shared/db/postgres/neon.js';
import { AuditWriter } from '../shared/auth/audit.js';
import type { BlobStore } from './storage/blobs.js';
import { MemoryBlobStore } from './storage/blobs.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

/**
 * Which storage backend this container talks to.
 *
 * - `snowflake` — SQL API v2 + key-pair JWT. Where this goes in production.
 * - `postgres`  — the Netlify database (Neon). MVP/UAT, so testers can react to
 *   a running system rather than waiting on a service-user approval. **No
 *   PostGIS**: geospatial derivation is deferred and its absence is recorded in
 *   the data (`src/shared/db/geo-assurance.ts`).
 * - `mock`      — fixtures, no database at all. `netlify dev` and the test suite.
 */
export type SqlBackend = 'snowflake' | 'postgres' | 'mock';

const SQL_BACKENDS: readonly SqlBackend[] = ['snowflake', 'postgres', 'mock'];

/**
 * Resolved once per cold start, in this order:
 *
 *  1. `SQL_BACKEND`, if set. Explicit always wins.
 *  2. `MOCK_SNOWFLAKE=1` → `mock`. Preserves the existing local-dev escape hatch
 *     that `src/server/dev/mock-mode.ts` established.
 *  3. **Both** `NETLIFY_DATABASE_URL` and `SNOWFLAKE_ACCOUNT` present → throw.
 *     Netlify injects its database URL into *every* deploy, so the day Snowflake
 *     credentials land both will be set, and picking one silently is how a
 *     production deploy ends up writing to the UAT database. `SQL_BACKEND` is
 *     one variable and this is exactly the moment to require it.
 *  4. One of the two present → that backend.
 *  5. Neither → `mock`, matching what `isMockMode()` already does with nothing
 *     configured, so a bare checkout still runs.
 */
export function sqlBackend(): SqlBackend {
  const explicit = optional('SQL_BACKEND');
  if (explicit) {
    if (!SQL_BACKENDS.includes(explicit as SqlBackend)) {
      throw new Error(
        `SQL_BACKEND must be one of ${SQL_BACKENDS.join(' | ')}, got "${explicit}"`,
      );
    }
    return explicit as SqlBackend;
  }

  if (process.env.MOCK_SNOWFLAKE === '1') return 'mock';

  const hasPostgres = !!optional('NETLIFY_DATABASE_URL');
  const hasSnowflake = !!optional('SNOWFLAKE_ACCOUNT');

  if (hasPostgres && hasSnowflake) {
    throw new Error(
      'both NETLIFY_DATABASE_URL and SNOWFLAKE_ACCOUNT are set; set SQL_BACKEND to ' +
        'snowflake or postgres to say which one this deployment uses',
    );
  }
  if (hasPostgres) return 'postgres';
  if (hasSnowflake) return 'snowflake';
  return 'mock';
}

export function snowflakeConfig(): SnowflakeConfig {
  return {
    account: required('SNOWFLAKE_ACCOUNT'),
    user: required('SNOWFLAKE_USER'),
    // Netlify env vars flatten newlines; PEM needs them back.
    privateKeyPem: required('SNOWFLAKE_PRIVATE_KEY').replace(/\\n/g, '\n'),
    privateKeyPassphrase: optional('SNOWFLAKE_PRIVATE_KEY_PASSPHRASE'),
    host: optional('SNOWFLAKE_HOST'),
    warehouse: optional('SNOWFLAKE_WAREHOUSE'),
    database: optional('SNOWFLAKE_DATABASE') ?? 'VCH_GEO',
    schema: optional('SNOWFLAKE_SCHEMA'),
    role: optional('SNOWFLAKE_ROLE'),
  };
}

let cachedClient: SnowflakeClient | null = null;

/** One client per warm container. Stateless, so this is caching config, not a pool. */
export function snowflake(): SnowflakeClient {
  cachedClient ??= new SnowflakeClient(snowflakeConfig());
  return cachedClient;
}

// ---------------------------------------------------------------------------
// Postgres (Netlify database)
// ---------------------------------------------------------------------------

/**
 * `NETLIFY_DATABASE_URL` is injected by Netlify into both builds and functions,
 * so no credential is handled by hand. Absent means misconfigured, not
 * "fall back to something" — a function that silently no-ops against a missing
 * database is the same class of fault as one that signs sessions with
 * `undefined`.
 */
export function databaseUrl(): string {
  return required('NETLIFY_DATABASE_URL');
}

/**
 * The URL the migration runner should use.
 *
 * Prefers the unpooled endpoint when Netlify provides one: DDL and
 * `pg_advisory_xact_lock` want a direct connection, not one handed out by a
 * transaction pooler. Falls back to the pooled URL, which works too.
 */
export function migrationDatabaseUrl(): string {
  return optional('NETLIFY_DATABASE_URL_UNPOOLED') ?? databaseUrl();
}

let cachedPostgres: PostgresClient | null = null;

/** One client per warm container. HTTP-per-query, so this caches config, not a pool. */
export function postgres(): PostgresClient {
  cachedPostgres ??= new PostgresClient({ executor: neonHttpExecutor(databaseUrl()) });
  return cachedPostgres;
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/**
 * The backend, behind the port. **This is what server code should depend on.**
 *
 * Throws on `mock`: there is no `SqlClient` for fixtures, and returning a
 * silently-empty one is precisely the failure this repo keeps designing against.
 * A caller that supports mock mode checks `isMockMode()`
 * (`src/server/dev/mock-mode.ts`) first and serves fixtures, as A2/C7/C8/C12
 * already do — it does not ask for a client it cannot have.
 */
export function sqlClient(): SqlClient {
  const backend = sqlBackend();
  switch (backend) {
    case 'snowflake':
      return snowflake();
    case 'postgres':
      return postgres();
    case 'mock':
      throw new Error(
        'sqlBackend() is "mock": no SQL client exists. Check isMockMode() and serve ' +
          'fixtures, or set SQL_BACKEND=postgres with NETLIFY_DATABASE_URL.',
      );
  }
}

/**
 * Office-side actor log.
 *
 * Still Snowflake-only: `AuditWriter` in `src/shared/auth/audit.ts` types its
 * dependency as `SnowflakeClient`, and the auth surface is deliberately out of
 * scope for the Netlify-database port — it keeps serving the existing
 * mock/fixture path. The guard below is here so the failure names the reason
 * rather than surfacing as "missing SNOWFLAKE_ACCOUNT" from three layers down.
 *
 * To port it: widen `AuditWriterOptions.snowflake` to `SqlClient` and change
 * this to `sqlClient()`. That file is not owned by the schema steward; the
 * request is recorded in the wave report.
 *
 * Note that `/ingest/commit` and `/ingest/retire` write `CURATED.AUDIT_EVENT`
 * through their own statements, not through this writer, so the ingest audit
 * trail is unaffected by the gap.
 */
export function auditWriter(): AuditWriter {
  if (sqlBackend() !== 'snowflake') {
    throw new Error(
      `auditWriter() requires SQL_BACKEND=snowflake; it is "${sqlBackend()}". ` +
        'AuditWriter is typed against SnowflakeClient and the auth surface has not ' +
        'been ported to the SQL port yet.',
    );
  }
  return new AuditWriter({ snowflake: snowflake(), ipHashSalt: required('IP_HASH_SALT') });
}

export const sessionSecret = () => required('SESSION_SECRET');
export const uploadSecret = () => required('MEDIA_UPLOAD_SECRET');
export const baseUrl = () => required('URL');

/** Session lifetime for the office surfaces. The sampler's window is separate. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

/**
 * Netlify Blobs, loaded lazily.
 *
 * The specifier goes through a variable on purpose: `@netlify/blobs` is
 * installed by F0.3, and until then a literal import would fail `typecheck`
 * for every lane. Falls back to an in-memory store so `netlify dev` and the
 * tests run with no binding at all.
 */
export async function blobStore(storeName = 'vch-sampling'): Promise<BlobStore> {
  const specifier = '@netlify/blobs';
  try {
    const mod = (await import(specifier)) as {
      getStore: (name: string) => {
        set(key: string, data: unknown, opts?: unknown): Promise<void>;
        get(key: string, opts: { type: 'arrayBuffer' }): Promise<ArrayBuffer | null>;
        getMetadata(key: string): Promise<{ size?: number } | null>;
      };
    };
    const store = mod.getStore(storeName);
    return {
      async put(key, data, meta) {
        await store.set(key, data, meta ? { metadata: meta } : undefined);
        return { key, bytes: data.byteLength };
      },
      async get(key) {
        const buf = await store.get(key, { type: 'arrayBuffer' });
        return buf ? new Uint8Array(buf) : null;
      },
      async head(key) {
        const buf = await store.get(key, { type: 'arrayBuffer' });
        return buf ? { key, bytes: buf.byteLength } : null;
      },
    };
  } catch {
    return new MemoryBlobStore();
  }
}
