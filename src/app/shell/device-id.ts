/**
 * B4/B5/B7/B11 wiring — a stable per-device identifier.
 *
 * Device enrolment/auth (plan v02 §8, `src/shared/auth/**`) is explicitly
 * phased and not built yet — nothing in this lane blocks on it. Every wire
 * payload that carries `device_id` still needs *something* stable across a
 * session so records from the same phone are recognisably the same phone
 * once auth lands. A `localStorage`-backed UUIDv7, generated once and reused,
 * is the smallest thing that satisfies that without inventing an enrolment
 * flow this wave does not own.
 *
 * Deliberately injectable (`storage` parameter) so this is testable without a
 * real `localStorage`, the same seam `wa-sqlite-opfs.ts` and `device-db.ts`
 * use for their own untestable-outside-a-browser primitives.
 */

import { uuidv7 } from 'uuidv7';

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const DEVICE_ID_KEY = 'vch_sampler_device_id';

let cached: string | null = null;

export function getOrCreateDeviceId(storage?: KeyValueStorage): string {
  if (cached) return cached;
  const store = storage ?? safeLocalStorage();
  if (store) {
    const existing = store.getItem(DEVICE_ID_KEY);
    if (existing) {
      cached = existing;
      return existing;
    }
    const created = uuidv7();
    store.setItem(DEVICE_ID_KEY, created);
    cached = created;
    return created;
  }
  // No storage available at all (e.g. a locked-down webview) — a per-load id
  // is still better than sending `null` on every sync record.
  cached = uuidv7();
  return cached;
}

/** Test-only: forces the next call to re-resolve rather than reuse the cache. */
export function _resetDeviceIdForTests(): void {
  cached = null;
}

function safeLocalStorage(): KeyValueStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    // Some browsers throw on `localStorage` access under strict privacy modes.
    return null;
  }
}
