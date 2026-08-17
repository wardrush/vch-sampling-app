/**
 * `<BoundaryMap>` — the one MapLibre + PMTiles surface in this repository.
 * Prop API is documented in `types.ts`; read that file's module doc first.
 *
 * One `maplibregl.Map` instance is created on mount and `remove()`d on
 * unmount (v02 §11 criterion 7 — a leaked GL context is a battery finding
 * on a mid-range Android). Sources and layers are created once and updated
 * in place via `setData`/`setPaintProperty`/`setFeatureState` afterwards,
 * so a re-render never tears down and rebuilds the map.
 */

import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import maplibregl from 'maplibre-gl';
import type { Map as MapLibreMap, GeoJSONSource, MapLayerMouseEvent } from 'maplibre-gl';
import type { FeatureCollection, Point as GeoPoint } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';

import { registerPmtilesProtocol } from './pmtiles-protocol.js';
import { buildStyle } from './style.js';
import { boundariesToGeoJSON, pointsToGeoJSON, boundsOfMapData } from './geojson.js';
import { statusColorExpression, DEFAULT_STATUS_COLOR, HOVER_STROKE_COLOR } from './colors.js';
import { metersToPixels } from './scale.js';
import type { BoundaryMapProps, DevicePosition } from './types.js';

const BOUNDARY_SOURCE_ID = 'boundary-map-boundaries';
const BOUNDARY_FILL_LAYER_ID = 'boundary-map-boundaries-fill';
const BOUNDARY_LINE_LAYER_ID = 'boundary-map-boundaries-line';
const POINT_SOURCE_ID = 'boundary-map-points';
const POINT_LAYER_ID = 'boundary-map-points-circle';
const DEVICE_SOURCE_ID = 'boundary-map-device-position';
const DEVICE_ACCURACY_LAYER_ID = 'boundary-map-device-accuracy';
const DEVICE_DOT_LAYER_ID = 'boundary-map-device-dot';

/**
 * Brand colours, isolated here as the single place `BoundaryMap.tsx` names
 * a hex literal (mirrors the pattern in `colors.ts`/`style.ts` — one named
 * constant per colour, referenced nowhere inline). See the brand-pass
 * report (`.claude/fleet/reports/map-surface-wave1.md`, "Brand pass") for
 * the full reasoning; summary of the judgement calls:
 *
 * - The basemap is raster satellite imagery — green/brown/tan ground.
 *   `moss` and `sand` are the *colours of that ground*, so they are safe
 *   for chrome and low-opacity area fills but a bad choice for anything
 *   that must read as a distinct edge or point against arbitrary aerial
 *   photography.
 * - `DEFAULT_BOUNDARY_FILL` (`moss-500`) is a translucent area wash
 *   (12% opacity) — brand-safe per the task's own guidance, and blending
 *   toward the ground is an acceptable (even thematically apt) trade for
 *   a fill, unlike a line or a pin.
 * - `DEFAULT_BOUNDARY_STROKE` (`gold-700`) is a judgement call, not a
 *   transcription: the *edge line* is a thin (2px) shape that has to read
 *   against whatever the imagery underneath happens to be, so it gets the
 *   same "must contrast with green/brown ground" treatment as point
 *   status, not the "brand is safe" treatment given to the fill. `gold-700`
 *   (darker than the `gold-500` used for the point fallback below) keeps
 *   boundary edges and unclassified-status pins visually distinguishable
 *   by shade as well as by shape (line vs. filled circle) — flagged in the
 *   report as the one place two brand-safe choices sit close enough in hue
 *   that they are worth calling out rather than assuming apart.
 * - `DEFAULT_POINT_STROKE_COLOR` (white) and `HOVER_STROKE_COLOR`
 *   (`sand-950`, in `colors.ts`) are the two outline colours the task's own
 *   guidance names as the legible options for a pin ring against arbitrary
 *   ground ("white or sand-950") — used as the two states (un-hovered /
 *   hovered) rather than picked arbitrarily.
 * - `DEFAULT_DEVICE_COLOR` (`moss-700`) is its own constant, not aliased to
 *   the boundary fill colour as it was pre-brand-pass — the task's safe
 *   list names "the accuracy ring" and "boundary fills" separately, and a
 *   darker, more saturated green than the boundary wash keeps "you are
 *   here" visually distinct from "this is the boundary" even though both
 *   are moss-family. Carries the same green-on-green caveat as the
 *   boundary fill; mitigated in practice by the white/`sand-950` stroke
 *   ring every circle layer in this file already gets.
 */
const DEFAULT_BOUNDARY_FILL = '#6f8a59';
const DEFAULT_BOUNDARY_STROKE = '#a67c17';
const DEFAULT_BOUNDARY_FILL_OPACITY = 0.12;
const DEFAULT_BOUNDARY_STROKE_WIDTH = 2;
/** Un-hovered pin/device-dot outline. Brand-pass: kept as literal white — the
 *  task's own guidance names "white or sand-950" as the two legible pin-ring
 *  options, and this is the "white" half, paired with `HOVER_STROKE_COLOR`
 *  (`sand-950`, in `colors.ts`) as the "sand-950" half. Not a leftover
 *  Tailwind default: it is the deliberate, brand-pass-endorsed choice. */
const DEFAULT_POINT_STROKE_COLOR = '#ffffff';
/** Device-position dot/accuracy-ring colour — its own brand value now, not
 *  an alias of `DEFAULT_BOUNDARY_FILL`. See the block comment above. */
const DEFAULT_DEVICE_COLOR = '#2f5332';
const POINT_RADIUS_PX = 7;
const POINT_HOVER_STROKE_WIDTH = 3;
const POINT_STROKE_WIDTH = 1;
const SINGLE_POINT_FALLBACK_ZOOM = 15;
const FIT_BOUNDS_PADDING_PX = 32;

/**
 * Long-press threshold for `onMapLongPress` ("long-press bare ground for a
 * field-added point", v02 §2). No millisecond value is written down
 * anywhere in the plan — 500 ms is the common OS long-press convention
 * (Android's `ViewConfiguration.getLongPressTimeout()` default), used here
 * as an unconfirmed default. See the wave-1 report's "Stopped, and why".
 */
const LONG_PRESS_MS = 500;
/** A pointer that has moved more than this many px cancels the long-press. */
const LONG_PRESS_MOVE_TOLERANCE_PX = 10;

function emptyPointCollection(): FeatureCollection<GeoPoint> {
  return { type: 'FeatureCollection', features: [] };
}

function devicePositionToGeoJSON(position: DevicePosition | null): FeatureCollection<GeoPoint> {
  if (!position) return emptyPointCollection();
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { accuracyM: position.accuracyM },
        geometry: { type: 'Point', coordinates: [position.lon, position.lat] },
      },
    ],
  };
}

function applyDeviceAccuracyRadius(map: MapLibreMap, position: DevicePosition | null): void {
  if (!map.getLayer(DEVICE_ACCURACY_LAYER_ID)) return;
  if (!position) {
    map.setPaintProperty(DEVICE_ACCURACY_LAYER_ID, 'circle-radius', 0);
    return;
  }
  const radiusPx = metersToPixels(position.accuracyM, position.lat, map.getZoom());
  map.setPaintProperty(DEVICE_ACCURACY_LAYER_ID, 'circle-radius', Math.max(radiusPx, 1));
}

function updateDevicePosition(map: MapLibreMap, position: DevicePosition | null): void {
  const source = map.getSource(DEVICE_SOURCE_ID) as GeoJSONSource | undefined;
  source?.setData(devicePositionToGeoJSON(position));
  applyDeviceAccuracyRadius(map, position);
}

/**
 * Creates sources/layers on first install, or refreshes their data in
 * place if they already exist (used after `setStyle` recreates the style,
 * e.g. when `tilePackUrl` changes mid-session — `setStyle` throws away
 * every custom source and layer, so this both installs and reinstalls).
 */
function installSourcesAndLayers(map: MapLibreMap, props: BoundaryMapProps): void {
  if (!map.getSource(BOUNDARY_SOURCE_ID)) {
    // `promoteId: 'id'` -- both boundary and point ids are UUIDv7 strings
    // (or, for the ingest preview, numeric-looking strings). MapLibre's
    // GeoJSON->vector-tile wrapper otherwise drops any `feature.id` it
    // cannot coerce to an integer (its own comment, at the FeatureWrapper
    // class in maplibre-gl's source, explains why: the vector tile spec
    // only supports integer feature ids). `pointsToGeoJSON`/
    // `boundariesToGeoJSON` already write `id` into `properties` for
    // exactly this reason -- `promoteId` tells MapLibre to read the real
    // id from there instead of the PBF-round-tripped, integer-only
    // `feature.id`, for both `queryRenderedFeatures` (click/hover) and
    // `setFeatureState`. Without this, `onPointClick` and hover
    // feature-state silently never fire for a UUID id -- see
    // `.claude/fleet/reports/wave-1-integration.md` §4.1.
    map.addSource(BOUNDARY_SOURCE_ID, {
      type: 'geojson',
      data: boundariesToGeoJSON(props.boundaries),
      promoteId: 'id',
    });
  } else {
    (map.getSource(BOUNDARY_SOURCE_ID) as GeoJSONSource).setData(boundariesToGeoJSON(props.boundaries));
  }
  if (!map.getLayer(BOUNDARY_FILL_LAYER_ID)) {
    map.addLayer({
      id: BOUNDARY_FILL_LAYER_ID,
      type: 'fill',
      source: BOUNDARY_SOURCE_ID,
      paint: {
        'fill-color': ['coalesce', ['get', 'fillColor'], DEFAULT_BOUNDARY_FILL],
        'fill-opacity': ['coalesce', ['get', 'fillOpacity'], DEFAULT_BOUNDARY_FILL_OPACITY],
      },
    });
  }
  if (!map.getLayer(BOUNDARY_LINE_LAYER_ID)) {
    map.addLayer({
      id: BOUNDARY_LINE_LAYER_ID,
      type: 'line',
      source: BOUNDARY_SOURCE_ID,
      paint: {
        'line-color': ['coalesce', ['get', 'strokeColor'], DEFAULT_BOUNDARY_STROKE],
        'line-width': ['coalesce', ['get', 'strokeWidth'], DEFAULT_BOUNDARY_STROKE_WIDTH],
      },
    });
  }

  if (!map.getSource(POINT_SOURCE_ID)) {
    // See the boundary source's `promoteId` comment above -- this is the
    // one that matters most: point ids are `plan_point_id`/`sample_uid`
    // (UUIDv7) on the sampler side, and both `onPointClick` and the
    // hover `feature-state` binding depend on the id surviving intact.
    map.addSource(POINT_SOURCE_ID, {
      type: 'geojson',
      data: pointsToGeoJSON(props.points),
      promoteId: 'id',
    });
  } else {
    (map.getSource(POINT_SOURCE_ID) as GeoJSONSource).setData(pointsToGeoJSON(props.points));
  }
  if (!map.getLayer(POINT_LAYER_ID)) {
    map.addLayer({
      id: POINT_LAYER_ID,
      type: 'circle',
      source: POINT_SOURCE_ID,
      paint: {
        'circle-radius': POINT_RADIUS_PX,
        'circle-color': DEFAULT_STATUS_COLOR,
        'circle-stroke-color': DEFAULT_POINT_STROKE_COLOR,
        'circle-stroke-width': POINT_STROKE_WIDTH,
      },
    });
  }
  // Data-driven paint expressions built from a caller-supplied Record are
  // set via setPaintProperty (accepts `any`) rather than in the addLayer
  // literal above — see colors.ts's module doc for why.
  map.setPaintProperty(
    POINT_LAYER_ID,
    'circle-color',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    statusColorExpression(props.statusColors, props.defaultStatusColor ?? DEFAULT_STATUS_COLOR) as any,
  );
  map.setPaintProperty(POINT_LAYER_ID, 'circle-stroke-color', [
    'case',
    ['boolean', ['feature-state', 'hover'], false],
    HOVER_STROKE_COLOR,
    DEFAULT_POINT_STROKE_COLOR,
  ]);
  map.setPaintProperty(POINT_LAYER_ID, 'circle-stroke-width', [
    'case',
    ['boolean', ['feature-state', 'hover'], false],
    POINT_HOVER_STROKE_WIDTH,
    POINT_STROKE_WIDTH,
  ]);

  if (!map.getSource(DEVICE_SOURCE_ID)) {
    map.addSource(DEVICE_SOURCE_ID, { type: 'geojson', data: emptyPointCollection() });
  }
  if (!map.getLayer(DEVICE_ACCURACY_LAYER_ID)) {
    map.addLayer({
      id: DEVICE_ACCURACY_LAYER_ID,
      type: 'circle',
      source: DEVICE_SOURCE_ID,
      paint: {
        'circle-radius': 0,
        'circle-color': DEFAULT_DEVICE_COLOR,
        'circle-opacity': 0.15,
        'circle-stroke-color': DEFAULT_DEVICE_COLOR,
        'circle-stroke-width': 1,
        'circle-stroke-opacity': 0.4,
      },
    });
  }
  if (!map.getLayer(DEVICE_DOT_LAYER_ID)) {
    map.addLayer({
      id: DEVICE_DOT_LAYER_ID,
      type: 'circle',
      source: DEVICE_SOURCE_ID,
      paint: {
        'circle-radius': 6,
        'circle-color': DEFAULT_DEVICE_COLOR,
        'circle-stroke-color': DEFAULT_POINT_STROKE_COLOR,
        'circle-stroke-width': 2,
      },
    });
  }
}

/**
 * Fits the camera to `boundaries`/`points` exactly once, and never again —
 * "the view yanked out from under them" is the failure `types.ts` names.
 * A no-op when the caller supplied `initialView` (camera set at
 * construction instead) or when a fit already happened this mount.
 */
function fitToDataOnce(
  map: MapLibreMap,
  props: BoundaryMapProps,
  firstFitDoneRef: MutableRefObject<boolean>,
): void {
  if (props.initialView || firstFitDoneRef.current) return;
  const bounds = boundsOfMapData(props.boundaries, props.points);
  if (!bounds) return;
  firstFitDoneRef.current = true;
  const [west, south, east, north] = bounds;
  if (west === east && south === north) {
    map.jumpTo({ center: [west, south], zoom: SINGLE_POINT_FALLBACK_ZOOM });
    return;
  }
  map.fitBounds(
    [
      [west, south],
      [east, north],
    ],
    { padding: FIT_BOUNDS_PADDING_PX, animate: false },
  );
}

/**
 * Wires pointer interaction once per `Map` instance (layer-delegated
 * listeners registered via `map.on(type, layerId, ...)` keep matching by
 * layer id across `setStyle` calls that recreate the same-named layer, so
 * this does not need to be re-run after a tile-pack swap).
 */
function wireInteractions(
  map: MapLibreMap,
  propsRef: MutableRefObject<BoundaryMapProps>,
  hoveredFeatureRef: MutableRefObject<string | null>,
): void {
  const setHover = (id: string | null, notify: boolean): void => {
    const prev = hoveredFeatureRef.current;
    if (prev === id) return;
    if (prev !== null) map.setFeatureState({ source: POINT_SOURCE_ID, id: prev }, { hover: false });
    if (id !== null) map.setFeatureState({ source: POINT_SOURCE_ID, id }, { hover: true });
    hoveredFeatureRef.current = id;
    if (notify) propsRef.current.onPointHover?.(id);
  };

  map.on('mousemove', POINT_LAYER_ID, (e: MapLayerMouseEvent) => {
    map.getCanvas().style.cursor = 'pointer';
    const feature = e.features?.[0];
    const id = feature?.id != null ? String(feature.id) : null;
    setHover(id, true);
  });
  map.on('mouseleave', POINT_LAYER_ID, () => {
    map.getCanvas().style.cursor = '';
    setHover(null, true);
  });
  map.on('click', POINT_LAYER_ID, (e: MapLayerMouseEvent) => {
    const feature = e.features?.[0];
    const id = feature?.id != null ? String(feature.id) : null;
    if (id !== null) propsRef.current.onPointClick?.(id);
  });

  map.on('zoom', () => {
    applyDeviceAccuracyRadius(map, propsRef.current.devicePosition ?? null);
  });

  // Long-press on bare ground -> field-added point (v02 §2). Implemented
  // on the raw canvas via pointer events (covers mouse + touch + pen)
  // rather than relying on a synthetic long-press event MapLibre does not
  // emit itself.
  const canvas = map.getCanvasContainer();
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let longPressStart: { x: number; y: number } | null = null;

  const cancelLongPress = (): void => {
    if (longPressTimer !== null) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
    longPressStart = null;
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (!propsRef.current.onMapLongPress) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    longPressStart = { x: e.clientX, y: e.clientY };
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      const hitLayers = [POINT_LAYER_ID, BOUNDARY_FILL_LAYER_ID].filter((id) => map.getLayer(id) !== undefined);
      const hit = hitLayers.length > 0 ? map.queryRenderedFeatures([x, y], { layers: hitLayers }) : [];
      if (hit.length === 0) {
        const lngLat = map.unproject([x, y]);
        propsRef.current.onMapLongPress?.({ lat: lngLat.lat, lon: lngLat.lng });
      }
    }, LONG_PRESS_MS);
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (!longPressStart) return;
    const dx = e.clientX - longPressStart.x;
    const dy = e.clientY - longPressStart.y;
    if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_TOLERANCE_PX) cancelLongPress();
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', cancelLongPress);
  canvas.addEventListener('pointercancel', cancelLongPress);
  canvas.addEventListener('pointerleave', cancelLongPress);
}

export function BoundaryMap(props: BoundaryMapProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const readyRef = useRef(false);
  const firstFitDoneRef = useRef(false);
  const hoveredFeatureRef = useRef<string | null>(null);
  const isFirstTilePackRenderRef = useRef(true);
  const propsRef = useRef(props);
  propsRef.current = props;

  // Mount once: create the one MapLibre instance for this component
  // instance and tear it down on unmount. Nothing here re-runs on prop
  // changes -- every prop is read through `propsRef` from inside the
  // 'load' handler and the interaction wiring, which always see the
  // latest render's values.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    registerPmtilesProtocol(maplibregl);

    const initial = propsRef.current.initialView;
    const map = new maplibregl.Map({
      container,
      style: buildStyle(propsRef.current.tilePackUrl),
      center: initial ? [initial.center.lon, initial.center.lat] : [0, 0],
      zoom: initial ? initial.zoom : 1,
      attributionControl: false,
    });
    mapRef.current = map;

    const handleLoad = (): void => {
      installSourcesAndLayers(map, propsRef.current);
      readyRef.current = true;
      fitToDataOnce(map, propsRef.current, firstFitDoneRef);
      wireInteractions(map, propsRef, hoveredFeatureRef);
      if (propsRef.current.hoveredPointId) {
        hoveredFeatureRef.current = propsRef.current.hoveredPointId;
        map.setFeatureState({ source: POINT_SOURCE_ID, id: propsRef.current.hoveredPointId }, { hover: true });
      }
      updateDevicePosition(map, propsRef.current.devicePosition ?? null);
    };
    map.on('load', handleLoad);

    return () => {
      readyRef.current = false;
      map.off('load', handleLoad);
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // `tilePackUrl` can change after mount (the pack finishes downloading,
  // or the ingest preview toggles it). `setStyle` replaces the whole
  // style and discards every custom source/layer, so they are
  // reinstalled -- along with the transient hover/device state, which
  // `setStyle` also discards -- once the new style finishes loading.
  const tilePackUrl = props.tilePackUrl;
  useEffect(() => {
    if (isFirstTilePackRenderRef.current) {
      isFirstTilePackRenderRef.current = false;
      return;
    }
    const map = mapRef.current;
    if (!map) return;
    readyRef.current = false;
    map.setStyle(buildStyle(tilePackUrl));
    map.once('style.load', () => {
      installSourcesAndLayers(map, propsRef.current);
      readyRef.current = true;
      fitToDataOnce(map, propsRef.current, firstFitDoneRef);
      if (hoveredFeatureRef.current) {
        map.setFeatureState({ source: POINT_SOURCE_ID, id: hoveredFeatureRef.current }, { hover: true });
      }
      updateDevicePosition(map, propsRef.current.devicePosition ?? null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tilePackUrl]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    (map.getSource(BOUNDARY_SOURCE_ID) as GeoJSONSource | undefined)?.setData(boundariesToGeoJSON(props.boundaries));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.boundaries]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    (map.getSource(POINT_SOURCE_ID) as GeoJSONSource | undefined)?.setData(pointsToGeoJSON(props.points));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.points]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || !map.getLayer(POINT_LAYER_ID)) return;
    map.setPaintProperty(
      POINT_LAYER_ID,
      'circle-color',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      statusColorExpression(props.statusColors, props.defaultStatusColor ?? DEFAULT_STATUS_COLOR) as any,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.statusColors, props.defaultStatusColor]);

  // Controlled hover, both directions -- see `types.ts` `hoveredPointId`.
  // Pointer-driven hover (wireInteractions) already updates
  // `hoveredFeatureRef` and calls `onPointHover`, so when the caller feeds
  // that id straight back in as `hoveredPointId` this effect is a no-op
  // (prev === next); it only does work when the caller sets hover from
  // elsewhere (a table row's `onMouseEnter`).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const nextId = props.hoveredPointId ?? null;
    const prevId = hoveredFeatureRef.current;
    if (prevId === nextId) return;
    if (prevId !== null) map.setFeatureState({ source: POINT_SOURCE_ID, id: prevId }, { hover: false });
    if (nextId !== null) map.setFeatureState({ source: POINT_SOURCE_ID, id: nextId }, { hover: true });
    hoveredFeatureRef.current = nextId;
  }, [props.hoveredPointId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    updateDevicePosition(map, props.devicePosition ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.devicePosition]);

  return (
    <div
      ref={containerRef}
      className={props.className}
      aria-label={props.ariaLabel ?? 'Map'}
      role="region"
      style={{ width: '100%', height: '100%' }}
    />
  );
}
