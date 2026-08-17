/**
 * B3 — pure prop -> GeoJSON transforms. No MapLibre/GL context needed;
 * these are exactly the functions `BoundaryMap.tsx` calls to build
 * `GeoJSONSource` data.
 */

import { describe, expect, it } from 'vitest';
import { boundariesToGeoJSON, boundsOfLngLat, boundsOfMapData, pointsToGeoJSON } from './geojson.js';
import type { MapBoundary, MapPoint } from './types.js';

const boundary: MapBoundary = {
  id: 'b1',
  label: 'Field A',
  geojson: {
    type: 'Polygon',
    coordinates: [
      [
        [-100, 40],
        [-100, 41],
        [-99, 41],
        [-99, 40],
        [-100, 40],
      ],
    ],
  },
  style: { fillColor: '#123456', fillOpacity: 0.3, strokeColor: '#654321', strokeWidth: 4 },
};

const point: MapPoint = { id: 'p1', lat: 40.5, lon: -99.5, status: 'pending', label: 'Point 1' };

describe('pointsToGeoJSON', () => {
  it('carries id, status and lon/lat through as a Point feature', () => {
    const fc = pointsToGeoJSON([point]);
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features).toHaveLength(1);
    const [feature] = fc.features;
    expect(feature?.id).toBe('p1');
    expect(feature?.properties).toEqual({ id: 'p1', status: 'pending', label: 'Point 1' });
    expect(feature?.geometry).toEqual({ type: 'Point', coordinates: [-99.5, 40.5] });
  });

  it('defaults a missing label to null rather than dropping the key', () => {
    const fc = pointsToGeoJSON([{ id: 'p2', lat: 0, lon: 0, status: 'flagged' }]);
    expect(fc.features[0]?.properties?.['label']).toBeNull();
  });

  it('empty input is an empty FeatureCollection', () => {
    expect(pointsToGeoJSON([])).toEqual({ type: 'FeatureCollection', features: [] });
  });
});

describe('boundariesToGeoJSON', () => {
  it('carries id, label and style fields through as properties', () => {
    const fc = boundariesToGeoJSON([boundary]);
    expect(fc.features).toHaveLength(1);
    const [feature] = fc.features;
    expect(feature?.id).toBe('b1');
    expect(feature?.properties).toEqual({
      id: 'b1',
      label: 'Field A',
      fillColor: '#123456',
      fillOpacity: 0.3,
      strokeColor: '#654321',
      strokeWidth: 4,
    });
    expect(feature?.geometry.type).toBe('Polygon');
  });

  it('unstyled boundaries carry null style properties, not missing keys', () => {
    const bare: MapBoundary = { id: 'b2', geojson: boundary.geojson };
    const fc = boundariesToGeoJSON([bare]);
    expect(fc.features[0]?.properties).toEqual({
      id: 'b2',
      label: null,
      fillColor: null,
      fillOpacity: null,
      strokeColor: null,
      strokeWidth: null,
    });
  });

  it('narrows MultiPolygon geometry through by type', () => {
    const multi: MapBoundary = {
      id: 'b3',
      geojson: {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [-100, 40],
              [-100, 41],
              [-99, 41],
              [-99, 40],
              [-100, 40],
            ],
          ],
        ],
      },
    };
    const fc = boundariesToGeoJSON([multi]);
    expect(fc.features[0]?.geometry.type).toBe('MultiPolygon');
  });
});

describe('boundsOfLngLat', () => {
  it('returns null for empty input', () => {
    expect(boundsOfLngLat([])).toBeNull();
  });

  it('computes [west, south, east, north] across scattered points', () => {
    const bounds = boundsOfLngLat([
      [-100, 40],
      [-98, 42],
      [-99, 39],
    ]);
    expect(bounds).toEqual([-100, 39, -98, 42]);
  });

  it('a single point produces a zero-size box, not null', () => {
    expect(boundsOfLngLat([[-99, 40]])).toEqual([-99, 40, -99, 40]);
  });
});

describe('boundsOfMapData', () => {
  it('spans both boundary rings and points', () => {
    const farPoint: MapPoint = { id: 'far', lat: 45, lon: -95, status: 'pending' };
    const bounds = boundsOfMapData([boundary], [farPoint]);
    expect(bounds).toEqual([-100, 40, -95, 45]);
  });

  it('falls back to points alone when there are no boundaries', () => {
    const bounds = boundsOfMapData([], [point]);
    expect(bounds).toEqual([-99.5, 40.5, -99.5, 40.5]);
  });

  it('null when both boundaries and points are empty', () => {
    expect(boundsOfMapData([], [])).toBeNull();
  });
});
