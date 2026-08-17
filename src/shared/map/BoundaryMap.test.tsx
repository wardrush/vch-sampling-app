/**
 * B3 — `<BoundaryMap>`'s interaction behaviour, under jsdom (no WebGL, so a
 * fake `maplibre-gl` module stands in for the real GL renderer -- this
 * test asserts wiring and id plumbing, not pixels).
 *
 * This file exists because of a gate finding, not a routine addition:
 * `BoundaryMap.tsx` (454 lines, every pointer/click/hover behaviour in the
 * component) had zero tests. `pointsToGeoJSON` sets `id: p.id` as a
 * **string** (a UUIDv7 on the sampler side), and MapLibre's GeoJSON ->
 * vector-tile wrapper silently drops any feature id it cannot coerce to an
 * integer (see the `promoteId` comment in `BoundaryMap.tsx`,
 * `installSourcesAndLayers`). That meant `onPointClick` never fired and the
 * hover `feature-state` binding never lit up for a real sampler id -- the
 * Field screen's two core interactions were dead, and neither `tsc` nor a
 * helpers-only test suite could see it. See
 * `.claude/fleet/reports/wave-1-integration.md` §4.1.
 *
 * The fake `Map` below intentionally reproduces the one behaviour that
 * matters for this bug: `addSource` records whether `promoteId` was
 * requested, and `queryRenderedFeatures`/the layer-event dispatch only
 * hand back `feature.id` when the *point* source it reads from was
 * registered with `promoteId: 'id'` -- exactly MapLibre's real rule (a
 * `feature.id` that fails `!isNaN(...)` is dropped unless `promoteId`
 * pulled the id from `properties` instead). Everything else (rendering,
 * tiles, GL) is out of scope for jsdom and is not claimed here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import type { BoundaryMapProps, MapPoint } from './types.js';

// react-dom/test-utils' `act` (no @testing-library/react in this repo's
// dependencies -- see `map-surface`'s agent file, no dependency may be
// added) checks this global before it will batch/flush effects quietly.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const UUID_POINT_ID = '01a00d8e-4c36-7a53-b1be-d20a9412a142';

type Handler = (...args: unknown[]) => void;

interface FakeSourceDef {
  type: 'geojson';
  data: unknown;
  promoteId?: string;
}

class FakeGeoJSONSource {
  data: unknown;
  promoteId?: string;
  constructor(def: FakeSourceDef) {
    this.data = def.data;
    this.promoteId = def.promoteId;
  }
  setData(data: unknown): void {
    this.data = data;
  }
}

/**
 * Reproduces exactly the one MapLibre rule this test exists to guard:
 * a GeoJSON source's features carry a real (possibly non-numeric)
 * `feature.id` in `queryRenderedFeatures`/layer-click results **only**
 * when the source was registered with `promoteId` — otherwise a
 * non-integer id is dropped (`feature.id` comes back `undefined`), same
 * as MapLibre's own `FeatureWrapper` (maplibre-gl source, the comment
 * `BoundaryMap.tsx` quotes).
 */
function featureIdForSource(source: FakeGeoJSONSource | undefined, rawId: string): string | undefined {
  if (!source) return undefined;
  if (source.promoteId) return rawId; // promoteId reads straight from properties -- survives intact
  return isNaN(Number(rawId)) ? undefined : String(parseInt(rawId, 10));
}

class FakeMap {
  static instances: FakeMap[] = [];

  private sources = new Map<string, FakeGeoJSONSource>();
  private layers = new Set<string>();
  private handlers = new Map<string, Handler[]>();
  private layerHandlers = new Map<string, Map<string, Handler[]>>();
  private featureState = new Map<string, Record<string, unknown>>();
  private canvas = { style: { cursor: '' } };
  private container: HTMLDivElement;
  removed = false;

  constructor(_options: unknown) {
    this.container = document.createElement('div');
    FakeMap.instances.push(this);
    // Real MapLibre fires 'load' asynchronously; a microtask is close
    // enough to exercise the same effect-ordering in the component.
    queueMicrotask(() => this.emit('load'));
  }

  on(type: string, arg2: unknown, arg3?: unknown): void {
    if (typeof arg2 === 'function') {
      const arr = this.handlers.get(type) ?? [];
      arr.push(arg2 as Handler);
      this.handlers.set(type, arr);
      return;
    }
    const layerId = arg2 as string;
    const handler = arg3 as Handler;
    const byLayer = this.layerHandlers.get(type) ?? new Map<string, Handler[]>();
    const arr = byLayer.get(layerId) ?? [];
    arr.push(handler);
    byLayer.set(layerId, arr);
    this.layerHandlers.set(type, byLayer);
  }

  off(type: string, handler: Handler): void {
    const arr = this.handlers.get(type);
    if (arr) this.handlers.set(type, arr.filter((h) => h !== handler));
  }

  once(type: string, handler: Handler): void {
    const wrapped: Handler = (...args) => {
      handler(...args);
      this.off(type, wrapped);
    };
    this.on(type, wrapped);
  }

  emit(type: string, payload?: unknown): void {
    for (const h of this.handlers.get(type) ?? []) h(payload);
  }

  /** Fires a point-layer click/hover event the way `map.on(type, layerId, handler)` would,
   *  handing back `feature.id` per `featureIdForSource` above. */
  emitPointFeatureEvent(type: string, layerId: string, rawId: string | null): void {
    const source = this.sources.get('boundary-map-points');
    const id = rawId === null ? undefined : featureIdForSource(source, rawId);
    const feature = rawId === null ? undefined : { id, properties: { id: rawId } };
    const handlers = this.layerHandlers.get(type)?.get(layerId) ?? [];
    for (const h of handlers) h({ features: feature ? [feature] : [] });
  }

  addSource(id: string, def: FakeSourceDef): void {
    this.sources.set(id, new FakeGeoJSONSource(def));
  }
  getSource(id: string): FakeGeoJSONSource | undefined {
    return this.sources.get(id);
  }
  addLayer(def: { id: string }): void {
    this.layers.add(def.id);
  }
  getLayer(id: string): object | undefined {
    return this.layers.has(id) ? {} : undefined;
  }
  setPaintProperty(): void {}
  setFeatureState(target: { source: string; id: string }, state: Record<string, unknown>): void {
    const key = `${target.source}:${target.id}`;
    this.featureState.set(key, { ...(this.featureState.get(key) ?? {}), ...state });
  }
  getFeatureState(target: { source: string; id: string }): Record<string, unknown> {
    return this.featureState.get(`${target.source}:${target.id}`) ?? {};
  }
  getCanvas(): { style: { cursor: string } } {
    return this.canvas;
  }
  getCanvasContainer(): HTMLDivElement {
    return this.container;
  }
  getZoom(): number {
    return 1;
  }
  jumpTo(): void {}
  fitBounds(): void {}
  setStyle(): void {}
  unproject(): { lat: number; lng: number } {
    return { lat: 0, lng: 0 };
  }
  queryRenderedFeatures(): unknown[] {
    return [];
  }
  remove(): void {
    this.removed = true;
  }
}

vi.mock('maplibre-gl', () => ({
  default: {
    Map: FakeMap,
    addProtocol: vi.fn(),
  },
}));
vi.mock('maplibre-gl/dist/maplibre-gl.css', () => ({}));
vi.mock('./pmtiles-protocol.js', () => ({
  registerPmtilesProtocol: vi.fn(),
}));

async function flushLoad(): Promise<void> {
  // Let the FakeMap's queued 'load' microtask (and the React effects it
  // triggers) run.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('<BoundaryMap> interaction wiring', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    FakeMap.instances.length = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  function basePoint(): MapPoint {
    return { id: UUID_POINT_ID, lat: 49.1, lon: -123.1, status: 'pending' };
  }

  async function renderMap(props: Partial<BoundaryMapProps>): Promise<FakeMap> {
    const { BoundaryMap } = await import('./BoundaryMap.js');
    const fullProps: BoundaryMapProps = {
      tilePackUrl: null,
      boundaries: [],
      points: [basePoint()],
      statusColors: { pending: '#9ca3af' },
      ...props,
    };
    act(() => {
      root.render(<BoundaryMap {...fullProps} />);
    });
    await flushLoad();
    const map = FakeMap.instances[FakeMap.instances.length - 1];
    if (!map) throw new Error('FakeMap was not constructed');
    return map;
  }

  it('registers the point source with promoteId so a UUIDv7 id survives', async () => {
    const map = await renderMap({});
    const pointSource = map.getSource('boundary-map-points');
    expect(pointSource?.promoteId).toBe('id');
  });

  it('registers the boundary source with promoteId too', async () => {
    const map = await renderMap({
      boundaries: [{ id: UUID_POINT_ID, geojson: { type: 'Polygon', coordinates: [] } }],
    });
    const boundarySource = map.getSource('boundary-map-boundaries');
    expect(boundarySource?.promoteId).toBe('id');
  });

  it('calls onPointClick with the UUIDv7 id when the point layer is clicked (promoteId path)', async () => {
    const onPointClick = vi.fn();
    const map = await renderMap({ onPointClick });

    map.emitPointFeatureEvent('click', 'boundary-map-points-circle', UUID_POINT_ID);

    expect(onPointClick).toHaveBeenCalledWith(UUID_POINT_ID);
  });

  it('does NOT call onPointClick when the id is dropped (promoteId absent) -- demonstrates the bug this test guards', async () => {
    const onPointClick = vi.fn();
    const map = await renderMap({ onPointClick });
    const pointSource = map.getSource('boundary-map-points');
    // Simulate the pre-fix world: no promoteId, so MapLibre's own
    // FeatureWrapper drops a UUID id (`isNaN` guard fails).
    if (pointSource) pointSource.promoteId = undefined;

    map.emitPointFeatureEvent('click', 'boundary-map-points-circle', UUID_POINT_ID);

    expect(onPointClick).not.toHaveBeenCalled();
  });

  it('sets feature-state hover on move and clears it on leave, keyed by the UUIDv7 id', async () => {
    const onPointHover = vi.fn();
    const map = await renderMap({ onPointHover });

    map.emitPointFeatureEvent('mousemove', 'boundary-map-points-circle', UUID_POINT_ID);
    expect(onPointHover).toHaveBeenCalledWith(UUID_POINT_ID);
    expect(map.getFeatureState({ source: 'boundary-map-points', id: UUID_POINT_ID })).toEqual({ hover: true });

    map.emitPointFeatureEvent('mouseleave', 'boundary-map-points-circle', null);
    expect(onPointHover).toHaveBeenCalledWith(null);
    expect(map.getFeatureState({ source: 'boundary-map-points', id: UUID_POINT_ID })).toEqual({ hover: false });
  });

  it('applies a caller-controlled hoveredPointId via feature-state (table row -> pin direction)', async () => {
    const map = await renderMap({ hoveredPointId: UUID_POINT_ID });
    expect(map.getFeatureState({ source: 'boundary-map-points', id: UUID_POINT_ID })).toEqual({ hover: true });
  });

  it('tears down the single Map instance on unmount', async () => {
    const map = await renderMap({});
    expect(map.removed).toBe(false);
    act(() => {
      root.unmount();
    });
    expect(map.removed).toBe(true);
  });
});
