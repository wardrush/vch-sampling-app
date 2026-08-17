/**
 * Client/mock-mode point-in-polygon. The server-of-record answer is always
 * Snowflake's `ST_WITHIN` (contract §6 step 4, `src/server/derive/pipeline.ts`)
 * — this is the local figure used for map preview highlighting (B3, C10) and
 * for `MOCK_SNOWFLAKE=1` local dev, where there is no warehouse to ask.
 */
import type { LatLon } from './distance.js';

type Ring = number[][];

function pointInRing(point: [number, number], ring: Ring): boolean {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0]!;
    const yi = ring[i]![1]!;
    const xj = ring[j]![0]!;
    const yj = ring[j]![1]!;
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Ring 0 is the shell, rings 1+ are holes. */
function pointInPolygonCoords(point: [number, number], polygon: number[][][]): boolean {
  if (!pointInRing(point, polygon[0] ?? [])) return false;
  for (let i = 1; i < polygon.length; i += 1) {
    if (pointInRing(point, polygon[i]!)) return false;
  }
  return true;
}

export function pointInPolygon(
  p: LatLon,
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon,
): boolean {
  const point: [number, number] = [p.lon, p.lat];
  if (geometry.type === 'Polygon') {
    return pointInPolygonCoords(point, geometry.coordinates as number[][][]);
  }
  return (geometry.coordinates as number[][][][]).some((poly) => pointInPolygonCoords(point, poly));
}

export function bboxOf(geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon): [number, number, number, number] {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const rings: number[][][] =
    geometry.type === 'Polygon'
      ? (geometry.coordinates as number[][][])
      : (geometry.coordinates as number[][][][]).flat();
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      if (lon! < west) west = lon!;
      if (lon! > east) east = lon!;
      if (lat! < south) south = lat!;
      if (lat! > north) north = lat!;
    }
  }
  return [west, south, east, north];
}
