/**
 * A minimal PNG pixel reader, for one purpose: telling a screenshot of an
 * *empty* MapLibre canvas apart from one with a boundary polygon actually
 * painted on it, without needing a baseline image to diff against.
 *
 * Why not `canvas.getContext('2d')`/`gl.readPixels()` in the page itself:
 * `<BoundaryMap>` (`src/shared/map/BoundaryMap.tsx`, not this agent's file)
 * does not set `preserveDrawingBuffer: true` on the MapLibre GL context, so
 * reading the WebGL drawing buffer directly is exactly the kind of flaky
 * check the task asked this suite to avoid — whether the last-rendered
 * frame is still in that buffer when the read happens is a timing race, not
 * a fact. A Playwright screenshot instead goes through the browser's own
 * compositor (`Page.captureScreenshot`), the same path that produces what a
 * human looking at the screen — or the coordinator's own screenshot that
 * found this bug — actually sees. That is a fact, not a race.
 *
 * Deliberately narrow: 8-bit depth, colour type 2 (RGB) or 6 (RGBA),
 * non-interlaced — what Chromium's screenshot encoder produces. Throws
 * rather than silently misreading anything else.
 */

import { inflateSync } from 'node:zlib';

export interface DecodedPng {
  width: number;
  height: number;
  channels: 3 | 4;
  data: Buffer;
}

export function decodePng(buf: Buffer): DecodedPng {
  const PNG_SIGNATURE_LENGTH = 8;
  let offset = PNG_SIGNATURE_LENGTH;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks: Buffer[] = [];

  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
      interlace = data.readUInt8(12);
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length; // length(4) + type(4) + data + crc(4)
  }

  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(
      `decodePng: unsupported PNG (bitDepth=${bitDepth}, colorType=${colorType}, interlace=${interlace}) — ` +
        `only 8-bit, non-interlaced RGB/RGBA (what Chromium's screenshot encoder produces) is handled.`,
    );
  }

  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idatChunks));
  const stride = width * channels;
  const scanlineLen = stride + 1; // +1 PNG filter-type byte per row
  const out = Buffer.alloc(height * stride);
  let prevRow = Buffer.alloc(stride);

  for (let row = 0; row < height; row++) {
    const filterType = raw[row * scanlineLen];
    const rowData = raw.subarray(row * scanlineLen + 1, row * scanlineLen + 1 + stride);
    const curRow = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? (curRow[i - channels] ?? 0) : 0;
      const b = prevRow[i] ?? 0;
      const c = i >= channels ? (prevRow[i - channels] ?? 0) : 0;
      let val = rowData[i] ?? 0;
      switch (filterType) {
        case 0: // None
          break;
        case 1: // Sub
          val = (val + a) & 0xff;
          break;
        case 2: // Up
          val = (val + b) & 0xff;
          break;
        case 3: // Average
          val = (val + Math.floor((a + b) / 2)) & 0xff;
          break;
        case 4: {
          // Paeth
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          val = (val + predictor) & 0xff;
          break;
        }
        default:
          throw new Error(`decodePng: unknown filter type ${filterType} on row ${row}`);
      }
      curRow[i] = val;
    }
    curRow.copy(out, row * stride);
    prevRow = curRow;
  }

  return { width, height, channels, data: out };
}

export function pixelAt(img: DecodedPng, x: number, y: number): [number, number, number] {
  const idx = (y * img.width + x) * img.channels;
  return [img.data[idx] ?? 0, img.data[idx + 1] ?? 0, img.data[idx + 2] ?? 0];
}

/** Sum of absolute per-channel differences — deliberately not a fussy
 *  perceptual distance metric, just "these two pixels are not the same
 *  flat colour." */
export function colorDistance(a: [number, number, number], b: [number, number, number]): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}
