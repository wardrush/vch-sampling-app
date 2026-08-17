/**
 * Screen 2 · Field (v02 §2). B5.
 *
 * Boundary polygon on a cached satellite basemap, planned points coloured by
 * state, live position with an accuracy ring. Tap a pin to capture;
 * long-press bare ground for a field-added point.
 *
 * **No satellite basemap this wave, and that is correct, not a bug.** The
 * demo fixture's `tile_pack.url` (`https://tiles.example.com/...`) does not
 * resolve, and the real PMTiles route-pack builder is B13 (wave 3). This
 * screen always passes `tilePackUrl={null}` to `<BoundaryMap>` — never a
 * live network style URL, per that component's own prop contract — so the
 * map renders the boundary and pins over `<BoundaryMap>`'s flat
 * brand-coloured background. See the wave-2 report.
 *
 * **Coarse position only** (v02 §3: "coarse-poll on map, off elsewhere").
 * The high-accuracy watch is Capture's (`@app/capture/gps.js`), started only
 * when a capture screen is actually open — this screen never asks for
 * `enableHighAccuracy`.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { BoundaryMap, type DevicePosition, type MapBoundary, type MapPoint } from '@shared/map';
import { Badge, Button, SEMANTIC_COLORS, SPACING, FONT_SIZES, FONT_WEIGHTS } from '@app/components/index.js';
import { useDeviceDb } from '@app/shell/db/DeviceDbProvider.js';
import { capturePath, captureNewPath } from '@app/shell/routes.js';
import {
  getBoundary,
  listPlanPoints,
  type DeviceBoundary,
  type DevicePlanPoint,
} from '@app/shell/bundle/queries.js';

// Map pin colours, from the same brand tokens as the rest of the app —
// no hex literals here (this agent's own non-negotiable). `<BoundaryMap>`
// owns its *default* fallback colour (`map-surface`'s territory); this is
// the caller-supplied vocabulary its `types.ts` module doc says is ours to
// define (v02 §2's three point states: not yet sampled, sampled, skipped).
const STATUS_COLORS: Record<string, string> = {
  pending: SEMANTIC_COLORS.focusRing, // gold — unresolved, needs attention
  sampled: SEMANTIC_COLORS.buttonPrimaryBg, // moss — done
  skipped: SEMANTIC_COLORS.textSecondary, // sand — deliberately set aside
};

export function FieldScreen(): React.JSX.Element {
  const { boundaryId } = useParams<{ boundaryId: string }>();
  const navigate = useNavigate();
  const dbState = useDeviceDb();

  const [boundary, setBoundary] = useState<DeviceBoundary | null>(null);
  const [points, setPoints] = useState<DevicePlanPoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [devicePosition, setDevicePosition] = useState<DevicePosition | null>(null);
  const [hoveredPointId, setHoveredPointId] = useState<string | null>(null);

  useEffect(() => {
    if (dbState.status !== 'ready' || !boundaryId) return;
    let cancelled = false;
    (async () => {
      try {
        const [b, p] = await Promise.all([
          getBoundary(dbState.db, boundaryId),
          listPlanPoints(dbState.db, boundaryId),
        ]);
        if (cancelled) return;
        setBoundary(b);
        setPoints(p);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load this boundary.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dbState.status, dbState.status === 'ready' ? dbState.db : null, boundaryId]);

  // Coarse device position. Best-effort — a device with no fix, or a
  // sandboxed/headless environment with no geolocation at all, just shows
  // no dot; the map itself never blocks on this.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return undefined;
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setDevicePosition({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracyM: pos.coords.accuracy });
      },
      () => {
        // Silently no dot — coarse position is a nicety, not a requirement.
      },
      { enableHighAccuracy: false, maximumAge: 30_000, timeout: 20_000 },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  const mapBoundaries = useMemo<MapBoundary[]>(() => {
    if (!boundary) return [];
    return [{ id: boundary.boundary_id, geojson: boundary.geojson, label: boundary.property_name }];
  }, [boundary]);

  const mapPoints = useMemo<MapPoint[]>(
    () =>
      points.map((p) => ({
        id: p.plan_point_id,
        lat: p.planned_lat,
        lon: p.planned_lon,
        status: p.local_status,
        label: p.plan_point_label,
      })),
    [points],
  );

  const done = points.filter((p) => p.local_status !== 'pending').length;

  if (!boundaryId) {
    return <div style={{ padding: SPACING.xl }}>Missing boundary.</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: SPACING.md,
          padding: SPACING.md,
          paddingTop: `calc(${SPACING.md} + env(safe-area-inset-top))`,
          borderBottom: `1px solid ${SEMANTIC_COLORS.borderDefault}`,
        }}
      >
        <Button variant="ghost" size="sm" onClick={() => navigate('/')}>
          ← Today
        </Button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: FONT_SIZES.base, fontWeight: FONT_WEIGHTS.bold, color: SEMANTIC_COLORS.textPrimary }}>
            {boundary?.property_name ?? boundaryId}
          </div>
          <div style={{ fontSize: FONT_SIZES.xs, color: SEMANTIC_COLORS.textSecondary }}>
            {done} of {points.length} points done
          </div>
        </div>
      </header>

      {error && (
        <div style={{ padding: SPACING.md }}>
          <Badge label={error} status="error" />
        </div>
      )}

      <div style={{ flex: 1, position: 'relative', minHeight: 240 }}>
        {boundary ? (
          <BoundaryMap
            tilePackUrl={null}
            boundaries={mapBoundaries}
            points={mapPoints}
            statusColors={STATUS_COLORS}
            hoveredPointId={hoveredPointId}
            onPointHover={setHoveredPointId}
            onPointClick={(id) => navigate(capturePath(boundaryId, id))}
            onMapLongPress={(coords) => navigate(captureNewPath(boundaryId), { state: coords })}
            devicePosition={devicePosition}
            ariaLabel={`Map of ${boundary.property_name ?? boundaryId}`}
            className="field-map"
          />
        ) : (
          <div style={{ padding: SPACING.xl }}>
            <Badge label="Loading boundary…" status="neutral" />
          </div>
        )}
      </div>

      <div
        style={{
          display: 'flex',
          overflowX: 'auto',
          gap: SPACING.sm,
          padding: SPACING.md,
          borderTop: `1px solid ${SEMANTIC_COLORS.borderDefault}`,
        }}
      >
        {points.map((p) => (
          <button
            key={p.plan_point_id}
            type="button"
            onClick={() => navigate(capturePath(boundaryId, p.plan_point_id))}
            onMouseEnter={() => setHoveredPointId(p.plan_point_id)}
            onMouseLeave={() => setHoveredPointId((cur) => (cur === p.plan_point_id ? null : cur))}
            style={{
              flexShrink: 0,
              minHeight: 48,
              padding: `${SPACING.sm} ${SPACING.md}`,
              borderRadius: 8,
              border: `1px solid ${hoveredPointId === p.plan_point_id ? SEMANTIC_COLORS.buttonPrimaryBg : SEMANTIC_COLORS.borderDefault}`,
              background: p.local_status === 'pending' ? SEMANTIC_COLORS.bgPrimary : SEMANTIC_COLORS.chipSuccessBg,
              color: SEMANTIC_COLORS.textPrimary,
              fontWeight: FONT_WEIGHTS.semibold,
              cursor: 'pointer',
            }}
          >
            {p.plan_point_label ?? p.plan_point_id}
          </button>
        ))}
      </div>
    </div>
  );
}
