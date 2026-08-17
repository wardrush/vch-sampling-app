/**
 * B8 — image processing. Plan v02 §4.4 and §9.
 *
 * Downscale to a 1920 px long edge at q≈0.72, SHA-256 the *stored* bytes, and
 * read EXIF from the **original** file before anything is re-encoded.
 *
 * That last ordering detail is the one that matters and the one that is easy to
 * get backwards: a canvas re-encode strips EXIF. Reading it afterwards yields
 * an empty object and a media row that quietly claims the photo carried no
 * position — which is the opposite of the audit property v02 §9 is asking for.
 * So EXIF comes off the original bytes, and the values are stored verbatim
 * alongside the full `EXIF_RAW`.
 *
 * The hash is taken over the bytes that are actually stored, not the original.
 * The hash addresses the object; hashing something else would make
 * `already_have` answer a question about a file nobody has.
 */

import type { ProcessedImage } from './types.js';

export const LONG_EDGE_PX = 1920;
export const JPEG_QUALITY = 0.72;

export interface ExifData {
  lat: number | null;
  lon: number | null;
  ts: string | null;
  raw: unknown;
}

/** Injected so tests run without a canvas and without `exifr`. */
export interface ImageCodec {
  /** Decodes to something `encodeJpeg` accepts, plus its natural size. */
  decode(bytes: Uint8Array): Promise<{ source: unknown; width: number; height: number }>;
  encodeJpeg(
    source: unknown,
    width: number,
    height: number,
    quality: number,
  ): Promise<Uint8Array>;
}

export interface ExifParser {
  parse(bytes: Uint8Array): Promise<ExifData>;
}

export interface Hasher {
  sha256Hex(bytes: Uint8Array): Promise<string>;
}

export interface ProcessOptions {
  codec: ImageCodec;
  exif: ExifParser;
  hasher: Hasher;
  longEdgePx?: number;
  quality?: number;
}

/** Preserves aspect ratio; never upscales a photo that is already smaller. */
export function targetSize(
  width: number,
  height: number,
  longEdge: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= longEdge) return { width, height };
  const scale = longEdge / longest;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export async function processImage(
  original: Uint8Array,
  options: ProcessOptions,
): Promise<ProcessedImage> {
  // EXIF first, from the original bytes. See the header comment.
  const exif = await options.exif.parse(original);

  const decoded = await options.codec.decode(original);
  const size = targetSize(decoded.width, decoded.height, options.longEdgePx ?? LONG_EDGE_PX);
  const bytes = await options.codec.encodeJpeg(
    decoded.source,
    size.width,
    size.height,
    options.quality ?? JPEG_QUALITY,
  );
  const content_hash = await options.hasher.sha256Hex(bytes);

  return {
    bytes,
    content_hash,
    width_px: size.width,
    height_px: size.height,
    mime_type: 'image/jpeg',
    byte_length: bytes.byteLength,
    exif_lat: exif.lat,
    exif_lon: exif.lon,
    exif_ts: exif.ts,
    exif_raw: exif.raw,
    // A cheap boolean so "how many photos carried their own fix" is a query
    // rather than a VARIANT unpack (addendum §3.1).
    exif_gps_present: exif.lat !== null && exif.lon !== null,
  };
}

/** WebCrypto — present in both the browser and Node 20+. */
export const webCryptoHasher: Hasher = {
  async sha256Hex(bytes: Uint8Array): Promise<string> {
    const view = new Uint8Array(bytes);
    const digest = await crypto.subtle.digest('SHA-256', view);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  },
};

/**
 * `createImageBitmap` + `OffscreenCanvas`.
 *
 * Both are available in the Android Chrome the crew will run. Kept out of
 * `processImage` so the pipeline stays testable in Node.
 */
export const browserCodec: ImageCodec = {
  async decode(bytes: Uint8Array) {
    const blob = new Blob([new Uint8Array(bytes)]);
    const bitmap = await createImageBitmap(blob);
    return { source: bitmap, width: bitmap.width, height: bitmap.height };
  },
  async encodeJpeg(source, width, height, quality) {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d canvas context unavailable');
    ctx.drawImage(source as ImageBitmap, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    return new Uint8Array(await blob.arrayBuffer());
  },
};
