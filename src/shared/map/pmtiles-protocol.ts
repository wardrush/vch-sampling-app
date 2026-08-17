/**
 * Registers the `pmtiles://` protocol MapLibre needs to range-read a local
 * `.pmtiles` file directly, with no tile server (v02 §4 stack table).
 *
 * MapLibre's `addProtocol` is a **module-level** registration, not a
 * per-`Map`-instance one. Every mounted `<BoundaryMap>` calling `new
 * Protocol()` would allocate a second, independent PMTiles chunk cache for
 * no reason and race the two over which one wins `addProtocol('pmtiles', …)`
 * last. This file makes registration idempotent so N mounted maps share one
 * `Protocol` instance.
 */

import { Protocol } from 'pmtiles';

let singleton: Protocol | null = null;

/** The subset of the `maplibre-gl` module surface this file needs — kept
 *  narrow so tests can pass a fake without importing the real GL module. */
export interface MapLibreProtocolHost {
  addProtocol(name: string, handler: Protocol['tile']): void;
}

export function registerPmtilesProtocol(maplibregl: MapLibreProtocolHost): Protocol {
  if (!singleton) {
    singleton = new Protocol();
  }
  // Re-registering the same handler on an already-registered name is a
  // harmless overwrite in MapLibre; doing it every mount (rather than only
  // the first) means a second <BoundaryMap> mounted after the first
  // unmounts never finds the protocol missing.
  maplibregl.addProtocol('pmtiles', singleton.tile);
  return singleton;
}

/** Test-only: clears the module singleton so tests don't leak state into each other. */
export function _resetPmtilesProtocolForTests(): void {
  singleton = null;
}
