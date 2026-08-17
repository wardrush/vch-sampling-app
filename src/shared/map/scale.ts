/**
 * Web-Mercator metres-per-pixel, used to size the device-position accuracy
 * ring in real metres rather than a fixed pixel radius that would lie about
 * scale as the sampler zooms.
 *
 * Cross-checked against the one number v02 §4.4 already worked out rather
 * than re-deriving the tile arithmetic: "at 47° N, z17 gives 0.815 m/px" —
 * see `scale.test.ts`. That is the only place this file leans on the plan
 * doc; it is not where pack-size numbers come from.
 */

const EARTH_CIRCUMFERENCE_M = 40075016.686;

/** Metres per screen pixel at a given latitude and (fractional) zoom. */
export function metersPerPixel(lat: number, zoom: number): number {
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  return (EARTH_CIRCUMFERENCE_M * Math.cos((clampedLat * Math.PI) / 180)) / Math.pow(2, zoom + 8);
}

/** Convert a real-world distance in metres to a pixel radius at this view. */
export function metersToPixels(meters: number, lat: number, zoom: number): number {
  const mpp = metersPerPixel(lat, zoom);
  if (!Number.isFinite(mpp) || mpp <= 0) return 0;
  return meters / mpp;
}
