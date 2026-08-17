/**
 * The one MapLibre style this repository builds. Offline-first is
 * structural here, not a runtime check: this function never references a
 * remote style JSON, a `glyphs` URL, or a `sprite` URL, so there is no code
 * path in `<BoundaryMap>` that reaches the network for anything other than
 * the PMTiles pack the caller explicitly hands it — and that pack is a
 * caller-resolved local resource URL (`types.ts` — `tilePackUrl`), not a
 * style API endpoint.
 *
 * The route pack is raster satellite imagery, not vector tiles — v02 §2
 * calls it "a cached satellite basemap", and §4.4's ~25 KB/tile figure is
 * raster-photo-sized, not vector-pbf-sized. That is *why* this style needs
 * no vector source-layer names invented ahead of B13 (wave 3): a raster
 * PMTiles source only needs a URL and a tile size.
 */

import type { StyleSpecification } from 'maplibre-gl';

export const PMTILES_URL_PREFIX = 'pmtiles://';
export const ROUTE_PACK_SOURCE_ID = 'boundary-map-route-pack';
export const ROUTE_PACK_LAYER_ID = 'boundary-map-route-pack-raster';
export const BACKGROUND_LAYER_ID = 'boundary-map-background';

/** Shown when `tilePackUrl` is `null` — never a network fallback, a flat colour. */
export const NO_PACK_BACKGROUND_COLOR = '#e7e3d8';

export function pmtilesUrl(localResourceUrl: string): string {
  return localResourceUrl.startsWith(PMTILES_URL_PREFIX)
    ? localResourceUrl
    : `${PMTILES_URL_PREFIX}${localResourceUrl}`;
}

/**
 * @param tilePackUrl a local, already-downloaded PMTiles resource URL, or
 *   `null` to render with no basemap at all (never a network style).
 */
export function buildStyle(tilePackUrl: string | null): StyleSpecification {
  const style: StyleSpecification = {
    version: 8,
    sources: {},
    layers: [
      {
        id: BACKGROUND_LAYER_ID,
        type: 'background',
        paint: { 'background-color': NO_PACK_BACKGROUND_COLOR },
      },
    ],
  };

  if (tilePackUrl) {
    style.sources[ROUTE_PACK_SOURCE_ID] = {
      type: 'raster',
      url: pmtilesUrl(tilePackUrl),
      tileSize: 256,
    };
    style.layers.push({
      id: ROUTE_PACK_LAYER_ID,
      type: 'raster',
      source: ROUTE_PACK_SOURCE_ID,
      paint: {},
    });
  }

  return style;
}
