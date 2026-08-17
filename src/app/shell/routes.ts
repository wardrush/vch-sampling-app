/**
 * B1 — the route table. The one file that names where each of the six
 * screens (v02 §2) lives, and the module wave 2/3 imports from rather than
 * hard-coding a path string a second time.
 *
 * **Route-naming convention (unspecified by v02, decided here):** path
 * segments are the screen noun, params are `snake_case`-free camel matching
 * the wire contract's identifiers (`boundaryId` ~ `AssignedBoundary.boundary_id`,
 * `pointId` ~ `BundlePlanPoint.plan_point_id`) so a screen can lift a param
 * straight into a bundle lookup without renaming it. If wave 2 needs a
 * different shape (e.g. a visit id in the path), change it here — nowhere
 * else references a literal route string.
 *
 * **Layout convention, also decided here:** Today / Outbox / Storage keep the
 * persistent bottom nav (`AppShell`) because a sampler jumps between them
 * mid-day. Field / Capture / Skip drop it (`FocusShell`) — v02 §3's "capture
 * never blocks" reads as "capture never competes for screen space" too, and a
 * muddy thumb has no business finding a nav bar under a live camera view.
 * Field keeps the header slim rather than nav-less because "how many points
 * are left on this boundary" is exactly what you'd otherwise open Today to
 * check.
 */

export const ROUTE_PATHS = {
  today: '/',
  field: '/field/:boundaryId',
  capture: '/capture/:boundaryId/:pointId',
  /** Long-press on bare ground — a field-added point with no plan_point_id yet. */
  captureNew: '/capture/:boundaryId/new',
  skip: '/skip/:boundaryId/:pointId',
  outbox: '/outbox',
  storage: '/storage',
  /** B14 / v02 D18 — first-run guided walkthrough on model data. `TodayScreen`
   *  redirects here once, the first time a device has no `tutorial_completed_ts`
   *  (`@app/shell/tutorial.js`); reachable any time after via Today's
   *  "show me again" link, per v02 §4.5. */
  tutorial: '/tutorial',
} as const;

export type RouteKey = keyof typeof ROUTE_PATHS;

export function fieldPath(boundaryId: string): string {
  return `/field/${boundaryId}`;
}

export function capturePath(boundaryId: string, pointId: string): string {
  return `/capture/${boundaryId}/${pointId}`;
}

export function captureNewPath(boundaryId: string): string {
  return `/capture/${boundaryId}/new`;
}

export function skipPath(boundaryId: string, pointId: string): string {
  return `/skip/${boundaryId}/${pointId}`;
}

/** The three persistent bottom-nav destinations. Order is display order. */
export interface NavDestination {
  key: RouteKey;
  path: string;
  label: string;
}

export const NAV_DESTINATIONS: readonly NavDestination[] = [
  { key: 'today', path: ROUTE_PATHS.today, label: 'Today' },
  { key: 'outbox', path: ROUTE_PATHS.outbox, label: 'Outbox' },
  { key: 'storage', path: ROUTE_PATHS.storage, label: 'Storage' },
];
