/**
 * Great-circle distance and bearing.
 *
 * Used by the device (GPS fix spread, B6) and by the server rules that compare
 * two positions. It is **not** used for `OFFSET_FROM_PLAN_M` — that is
 * `ST_DISTANCE` in Snowflake, computed in one place so there is one answer
 * (contract §6 step 6). The device's local figure is advisory and is not
 * stored, and this module is how the device computes the advisory one.
 *
 * Haversine on a sphere is accurate to ~0.3% against WGS84 ellipsoidal
 * distance, which at the tens-of-metres scale this is used at is millimetres.
 */

const EARTH_RADIUS_M = 6_371_008.8;

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

export interface LatLon {
  lat: number;
  lon: number;
}

export function haversineMetres(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing a→b, degrees clockwise from true north, 0–360. */
export function bearingDegrees(a: LatLon, b: LatLon): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Arithmetic mean position. Fine at the metre scale a composite spans. */
export function meanPosition(points: readonly LatLon[]): LatLon | null {
  if (points.length === 0) return null;
  let lat = 0;
  let lon = 0;
  for (const p of points) {
    lat += p.lat;
    lon += p.lon;
  }
  return { lat: lat / points.length, lon: lon / points.length };
}

/**
 * The widest separation between any two fixes, in metres.
 *
 * Spread is the honest measure of a fix's quality — the receiver's own
 * accuracy number is a claim, and a set of fixes 40 m apart contradicts a claim
 * of 5 m. That contradiction is the finding.
 */
export function maxSpreadMetres(points: readonly LatLon[]): number {
  let max = 0;
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      max = Math.max(max, haversineMetres(points[i]!, points[j]!));
    }
  }
  return max;
}
