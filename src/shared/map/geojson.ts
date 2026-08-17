/**
 * Pure transforms from `<BoundaryMap>`'s domain-agnostic props into GeoJSON
 * `FeatureCollection`s for MapLibre's GeoJSON sources. No MapLibre import
 * here on purpose — these run and are tested without a GL context.
 */

import type { Feature, FeatureCollection, Point, Polygon, MultiPolygon } from 'geojson';
import type { MapBoundary, MapPoint } from './types.js';

export function pointsToGeoJSON(points: MapPoint[]): FeatureCollection<Point> {
  return {
    type: 'FeatureCollection',
    features: points.map((p): Feature<Point> => ({
      type: 'Feature',
      id: p.id,
      properties: {
        id: p.id,
        status: p.status,
        label: p.label ?? null,
      },
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    })),
  };
}

export function boundariesToGeoJSON(
  boundaries: MapBoundary[],
): FeatureCollection<Polygon | MultiPolygon> {
  return {
    type: 'FeatureCollection',
    features: boundaries.map((b): Feature<Polygon | MultiPolygon> => ({
      type: 'Feature',
      id: b.id,
      properties: {
        id: b.id,
        label: b.label ?? null,
        fillColor: b.style?.fillColor ?? null,
        fillOpacity: b.style?.fillOpacity ?? null,
        strokeColor: b.style?.strokeColor ?? null,
        strokeWidth: b.style?.strokeWidth ?? null,
      },
      // GeoJsonPolygon.coordinates is typed loosely (number[][][] |
      // number[][][][]) in shared/contract/common.ts to avoid that module
      // depending on @types/geojson; narrow it back here by `type`.
      geometry:
        b.geojson.type === 'Polygon'
          ? { type: 'Polygon', coordinates: b.geojson.coordinates as Polygon['coordinates'] }
          : { type: 'MultiPolygon', coordinates: b.geojson.coordinates as MultiPolygon['coordinates'] },
    })),
  };
}

/** `[west, south, east, north]`, or `null` for an empty input. */
export function boundsOfLngLat(coords: Array<[number, number]>): [number, number, number, number] | null {
  if (coords.length === 0) return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lon, lat] of coords) {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return [west, south, east, north];
}

function ringsOf(geom: Polygon | MultiPolygon): number[][][] {
  return geom.type === 'Polygon' ? [geom.coordinates[0] ?? []] : geom.coordinates.map((poly) => poly[0] ?? []);
}

/** Bounds spanning every boundary polygon and every point. `null` when both are empty. */
export function boundsOfMapData(
  boundaries: MapBoundary[],
  points: MapPoint[],
): [number, number, number, number] | null {
  const coords: Array<[number, number]> = [];
  for (const b of boundaries) {
    const geom: Polygon | MultiPolygon =
      b.geojson.type === 'Polygon'
        ? { type: 'Polygon', coordinates: b.geojson.coordinates as Polygon['coordinates'] }
        : { type: 'MultiPolygon', coordinates: b.geojson.coordinates as MultiPolygon['coordinates'] };
    for (const ring of ringsOf(geom)) {
      for (const pos of ring) {
        const lon = pos[0];
        const lat = pos[1];
        if (typeof lon === 'number' && typeof lat === 'number') coords.push([lon, lat]);
      }
    }
  }
  for (const p of points) {
    coords.push([p.lon, p.lat]);
  }
  return boundsOfLngLat(coords);
}
