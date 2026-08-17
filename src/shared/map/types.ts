/**
 * `<BoundaryMap>` prop API — the one MapLibre surface in this repository.
 *
 * B3 · SAMPLING_APP_PLAN_v02.md §2 (Field screen), §4.4 (tile arithmetic),
 * PLAN_INGEST_SPEC_v01.md §6 (the ingest map preview).
 *
 * Two consumers, one component. Neither the sampler's device-local point
 * status vocabulary (`pending` / `sampled` / `skipped`, plus a server-raised
 * defect flag — `device_sqlite_v01.sql` `sample_plan_point.local_status`)
 * nor the ingest tool's row status vocabulary (`RowStatus` in
 * `src/shared/contract/ingest.ts`: `ready` / `flagged` / `blocked` /
 * `committed` / `superseded`) is baked in here. `<BoundaryMap>` renders
 * whatever status string a point carries through a caller-supplied colour
 * map (`statusColors`) — that is the deliberate seam that keeps the two
 * consumers from forcing a shared enum that belongs to neither of them.
 */

import type { GeoJsonPolygon } from '../contract/common.js';

/** A boundary polygon for context. Neutral by default; `style` overrides per boundary. */
export interface MapBoundary {
  /** Stable id — `AssignedBoundary.boundary_id` on the sampler side. */
  id: string;
  geojson: GeoJsonPolygon;
  label?: string | null;
  style?: {
    fillColor?: string;
    fillOpacity?: number;
    strokeColor?: string;
    strokeWidth?: number;
  };
}

/**
 * An arbitrary point, coloured by validation/capture status.
 *
 * Deliberately generic: the sampler passes planned/field-added sample
 * points, the ingest preview passes parsed spreadsheet rows. Neither
 * domain type is imported here — the caller maps its own rows/points into
 * this shape and back out again via `id`.
 */
export interface MapPoint {
  /** Stable id, round-tripped through `onPointHover`/`onPointClick`.
   *  Sampler: `plan_point_id` or `sample_uid`. Ingest: `source_row_no` (as a string). */
  id: string;
  lat: number;
  lon: number;
  /** Looked up in `statusColors`; unrecognised values fall back to `defaultStatusColor`. */
  status: string;
  /** Short text for a tooltip/callout. Optional — neither consumer requires one to render. */
  label?: string | null;
}

/** Device position with a GPS accuracy ring, in metres. Sampler Field screen only. */
export interface DevicePosition {
  lat: number;
  lon: number;
  accuracyM: number;
}

export interface MapLngLat {
  lat: number;
  lon: number;
}

export interface BoundaryMapProps {
  /**
   * A local, already-downloaded, content-verified PMTiles route pack
   * (raster satellite imagery — v02 §2 "cached satellite basemap", §4.4
   * tile arithmetic assumes raster ~25 KB/tile). This is a resource URL
   * the caller already resolved (a `blob:`/`file:` URL, or an OPFS-backed
   * path) — **never a live map-style API URL**. `<BoundaryMap>` will not
   * reach for a network basemap on its own; when this is `null` the map
   * renders boundaries and points over a flat neutral background instead
   * of silently falling back to a style server. `null` is the expected
   * value for the ingest preview, which has no offline requirement and
   * no per-boundary satellite pack; the sampler Field screen always
   * supplies one (offline-first is non-negotiable there).
   */
  tilePackUrl: string | null;

  /** Boundary polygons for context. Field screen: the one open boundary.
   *  Ingest preview: every assigned boundary in view (spec §6). */
  boundaries: MapBoundary[];

  /** Points, coloured by `statusColors[point.status]`. */
  points: MapPoint[];

  /** status -> CSS colour. Caller-owned vocabulary — see module doc comment. */
  statusColors: Record<string, string>;
  /** Colour for a `point.status` absent from `statusColors`. Default: neutral grey. */
  defaultStatusColor?: string;

  /**
   * Controlled hover, by point id. Ingest spec §6: "Hovering a table row
   * highlights its pin and vice versa." Set this from a table row's
   * `onMouseEnter`/`onMouseLeave` to highlight the matching pin; read
   * `onPointHover` to highlight the matching table row when the pin itself
   * is hovered. `null` clears the highlight either direction.
   */
  hoveredPointId?: string | null;
  /** Fires when the hovered pin changes because of pointer movement on the map itself. */
  onPointHover?: (id: string | null) => void;

  /** Sampler: tap a pin -> open Capture. Ingest preview may leave this unset. */
  onPointClick?: (id: string) => void;

  /**
   * Sampler only: long-press bare ground -> field-added point (v02 §2).
   * Omit to disable long-press handling entirely (the ingest preview does
   * not use it). Threshold is `LONG_PRESS_MS` — not specified in v02 §2,
   * see the wave-1 report's "Stopped, and why".
   */
  onMapLongPress?: (coords: MapLngLat) => void;

  /** Sampler only: live position + accuracy ring. `null`/omitted hides it. */
  devicePosition?: DevicePosition | null;

  /**
   * Initial camera. If omitted, `<BoundaryMap>` fits once, on first style
   * load, to the bounds of `boundaries` (falling back to `points` if there
   * are no boundaries). **Camera never moves again on its own** — a
   * `points`/`boundaries` update after that (e.g. a point flips from
   * `pending` to `sampled` after Save) re-renders the data in place and
   * does not recentre or rezoom. A sampler standing in a field must not
   * have the view yanked out from under them.
   */
  initialView?: { center: MapLngLat; zoom: number } | null;

  className?: string;
  ariaLabel?: string;
}
