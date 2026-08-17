/**
 * Status -> colour resolution. The caller owns the status vocabulary (see
 * `types.ts` module doc) — this file only turns whatever map it supplies
 * into a colour for one point (`resolveStatusColor`) or a MapLibre `match`
 * expression covering every point in one paint property (`statusColorExpression`).
 */

/**
 * Fallback fill — used when a point's `status` key is absent from the
 * caller's `statusColors` map. This is the one point colour this module
 * itself chooses (every other point colour is caller-supplied), so it is
 * the one place the brand-pass legibility argument for points actually
 * applies here: brand `gold-500`, chosen over a neutral grey because an
 * unrecognised status is worth surfacing as visually distinct rather than
 * blended into the background, and gold reads reliably against the green/
 * brown ground a raster satellite basemap actually shows (moss/sand do
 * not — see the module's brand-pass note in `BoundaryMap.tsx`).
 */
export const DEFAULT_STATUS_COLOR = '#d4a832';

/**
 * Highlight colour for the hovered point's stroke, independent of status
 * colour. Brand `sand-950` — paired with `DEFAULT_POINT_STROKE_COLOR`
 * (white) in `BoundaryMap.tsx` so the un-hovered/hovered states stay two
 * legible, brand-only colours rather than one brand and one Tailwind grey.
 */
export const HOVER_STROKE_COLOR = '#1f1408';

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
