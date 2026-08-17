/**
 * Runtime configuration, read once per cold start.
 *
 * Every secret is required explicitly and fails loudly at boot rather than
 * defaulting to something that half-works. A function that silently signs
 * sessions with `undefined` is worse than one that will not start.
 */

import { SnowflakeClient, type SnowflakeConfig } from '../shared/snowflake/client.js';
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

export function auditWriter(): AuditWriter {
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
