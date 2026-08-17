/**
 * B8 (wave 2) — the real EXIF reader, and the browser's `ProcessOptions`.
 *
 * `pipeline.ts` takes its codec, EXIF parser and hasher as parameters so it
 * can be tested in Node. This is the wiring the app actually runs, and it is
 * separate for exactly that reason: importing `exifr` into the pipeline would
 * put a browser-shaped dependency in the one file whose behaviour has to be
 * provable under `npm test`.
 *
 * **Three rules, all from v02 §9, all easy to violate by being helpful:**
 *
 *  1. **Values are not reconciled with anything.** What the file says is what
 *     is stored. `EXIF_POSITION_MISMATCH` is a defect rule precisely because
 *     the two positions are allowed to disagree; an app that quietly aligned
 *     them would delete the finding.
 *  2. **Values are not rounded.** `exifr` returns full-precision decimal
 *     degrees from the rational triples; those go through untouched.
 *  3. **The timestamp keeps its zone, or its lack of one.** EXIF
 *     `DateTimeOriginal` is local time with no offset. If the file also
 *     carries `OffsetTimeOriginal` (EXIF 2.31+) the offset is used, because
 *     the file said it. If it does not, the value is emitted **without a zone
 *     designator** — `2026-10-02T15:00:00`, never `…Z`. Appending `Z` would
 *     invent a timezone, and a fabricated hour is exactly the sort of thing
 *     that reads as fact in 2029.
 *
 * `EXIF_RAW` is stored alongside, so anything this function chooses not to
 * interpret is still recoverable from the row itself.
 */

import exifr from 'exifr';
import type { ExifData, ExifParser, ProcessOptions } from './pipeline.js';
import { browserCodec, webCryptoHasher } from './pipeline.js';

/**
 * Tag groups read for `EXIF_RAW`.
 *
 * `makerNote` and `userComment` are left off (`exifr`'s default): they are
 * vendor-opaque binary that would land in a VARIANT as a many-thousand-key
 * numeric object. Everything a rule or an auditor uses — GPS, DateTime, Make,
 * Model, orientation — is in the groups below.
 */
const RAW_OPTIONS = {
  tiff: true,
  ifd0: true,
  exif: true,
  gps: true,
  interop: false,
  translateKeys: true,
  translateValues: false,
  reviveValues: false,
  sanitize: true,
  mergeOutput: true,
} as const;

/**
 * `exifr`'s bundled `.d.ts` types the per-block flags as option objects, while
 * the library documents and accepts booleans for the same fields. The cast is
 * at this one line rather than spread through the parser.
 */
const RAW_OPTIONS_ARG = RAW_OPTIONS as unknown as Parameters<typeof exifr.parse>[1];

export const exifrParser: ExifParser = {
  async parse(bytes: Uint8Array): Promise<ExifData> {
    const raw = await parseRaw(bytes);
    const gps = await parseGps(bytes);
    return {
      lat: gps?.latitude ?? null,
      lon: gps?.longitude ?? null,
      ts: exifTimestamp(raw),
      raw,
    };
  },
};

/** What the app runs in a browser: real canvas, real EXIF, real SHA-256. */
export function browserImaging(): ProcessOptions {
  return { codec: browserCodec, exif: exifrParser, hasher: webCryptoHasher };
}

async function parseRaw(bytes: Uint8Array): Promise<Record<string, unknown> | null> {
  try {
    const parsed = (await exifr.parse(bytes, RAW_OPTIONS_ARG)) as
      | Record<string, unknown>
      | undefined;
    return parsed ? (jsonSafe(parsed) as Record<string, unknown>) : null;
  } catch {
    // A file with no EXIF, or EXIF this build cannot read, is a fact about the
    // photograph — not an error worth failing a capture over. `null` records
    // "nothing was there", which is what `exif_gps_present: false` then means.
    return null;
  }
}

async function parseGps(bytes: Uint8Array): Promise<{ latitude: number; longitude: number } | null> {
  try {
    const gps = (await exifr.gps(bytes)) as { latitude?: number; longitude?: number } | undefined;
    if (!gps || typeof gps.latitude !== 'number' || typeof gps.longitude !== 'number') return null;
    // Full precision, verbatim. No rounding, no datum shift, no comparison
    // against the app's own fix.
    return { latitude: gps.latitude, longitude: gps.longitude };
  } catch {
    return null;
  }
}

/**
 * `2026:10:02 15:00:00` → `2026-10-02T15:00:00`, plus the file's own offset if
 * it carries one. Returns null rather than guessing at anything else.
 */
export function exifTimestamp(raw: Record<string, unknown> | null): string | null {
  if (!raw) return null;
  const source = firstString(raw, ['DateTimeOriginal', 'CreateDate', 'ModifyDate', 'DateTime']);
  if (!source) return null;

  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(source.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const local = `${y}-${mo}-${d}T${h}:${mi}:${s}`;

  const offset = firstString(raw, ['OffsetTimeOriginal', 'OffsetTime']);
  if (offset && /^[+-]\d{2}:\d{2}$/.test(offset.trim())) return `${local}${offset.trim()}`;
  // No offset in the file, so none in the value. See the header.
  return local;
}

function firstString(raw: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/** Typed arrays and dates survive `JSON.stringify` as something readable. */
function jsonSafe(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (ArrayBuffer.isView(value)) return Array.from(new Uint8Array((value as Uint8Array).buffer));
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = jsonSafe(v);
    return out;
  }
  return value;
}
