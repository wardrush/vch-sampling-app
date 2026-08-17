/**
 * `src/shared/map` barrel. Both consumers (sampler Field screen, ingest
 * preview panel) import `<BoundaryMap>` and its prop types from this one
 * path -- never reach into a sibling file directly, and never construct a
 * second `maplibregl.Map` elsewhere in the app.
 */

export { BoundaryMap } from './BoundaryMap.js';
export type { BoundaryMapProps, MapBoundary, MapPoint, DevicePosition, MapLngLat } from './types.js';

export { buildStyle, pmtilesUrl, NO_PACK_BACKGROUND_COLOR } from './style.js';
export { registerPmtilesProtocol } from './pmtiles-protocol.js';
export {
  pointsToGeoJSON,
  boundariesToGeoJSON,
  boundsOfLngLat,
  boundsOfMapData,
} from './geojson.js';
export { resolveStatusColor, statusColorExpression, DEFAULT_STATUS_COLOR, HOVER_STROKE_COLOR } from './colors.js';
export { metersPerPixel, metersToPixels } from './scale.js';
