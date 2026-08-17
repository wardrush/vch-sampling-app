/**
 * Status -> colour resolution. The caller owns the status vocabulary (see
 * `types.ts` module doc) — this file only turns whatever map it supplies
 * into a colour for one point (`resolveStatusColor`) or a MapLibre `match`
 * expression covering every point in one paint property (`statusColorExpression`).
 */

/** Neutral grey — used when a point's `status` key is absent from the caller's map. */
export const DEFAULT_STATUS_COLOR = '#6b7280';

/** Highlight colour for the hovered point's stroke, independent of status colour. */
export const HOVER_STROKE_COLOR = '#111827';

export function resolveStatusColor(
  status: string,
  statusColors: Record<string, string>,
  fallback: string = DEFAULT_STATUS_COLOR,
): string {
  return statusColors[status] ?? fallback;
}

/**
 * A MapLibre `['match', ['get', 'status'], ...]` expression, so the GL layer
 * colours every point in one paint property instead of the app touching one
 * feature at a time. Untyped as `unknown[]` deliberately: MapLibre's
 * `ExpressionSpecification` is a large literal-tuple union that a
 * dynamically-built expression can't satisfy structurally, and the paint
 * property setter accepts it via a narrow cast at the one call site in
 * `BoundaryMap.tsx`.
 */
export function statusColorExpression(
  statusColors: Record<string, string>,
  fallback: string = DEFAULT_STATUS_COLOR,
): unknown[] {
  const expr: unknown[] = ['match', ['get', 'status']];
  for (const [status, color] of Object.entries(statusColors)) {
    expr.push(status, color);
  }
  expr.push(fallback);
  return expr;
}
