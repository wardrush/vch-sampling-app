# map-surface — wave 1

**Tasks:** B3 · `<BoundaryMap>` — the MapLibre + PMTiles wrapper
**Gate:** `npm run typecheck && npm test` → ran twice, both green in isolation on `src/shared/map/**`:
- `npm run typecheck` alone: clean, 0 errors, immediately after all files in this report landed.
- `npm test`: **152/152 passing, 16 test files** (116 inherited + 36 new in `src/shared/map/**`), on every run including the final one below.
- A later combined `npm run typecheck && npm test` run picked up three fresh `TS4114` (`override` modifier) errors in `src/app/shell/ErrorBoundary.tsx` — that file belongs to `pwa-screens`, mid-write concurrently in this same wave, not touched by this agent, and outside `src/shared/map/**`/`tools/pmtiles/**`. Zero errors reference any path this agent owns.
(This ran against a tree other agents were still writing to. See FLEET.md §4.5; the authoritative run is `fleet-integrator`'s.)

**This is a continuation of an interrupted wave-1 run.** `types.ts`, `style.ts`, `geojson.ts`, `pmtiles-protocol.ts`, `colors.ts`, `scale.ts` were inherited from that run, verified complete and correct, and left unmodified except where noted below. `BoundaryMap.tsx` (the component itself), `index.ts` (the barrel), all five `*.test.ts` files, and this report are new in this session.

---

## `<BoundaryMap>` prop API

This is unchanged from the inherited `types.ts` — verified sound against both consumers while building the real component against it, not just read. Reproduced here in full because this is what B5 and C10 build against.

```typescript
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
   * (raster satellite imagery). A resource URL the caller already
   * resolved (`blob:`/`file:`/OPFS-backed) — **never a live map-style API
   * URL**. `null` renders boundaries/points over a flat neutral background
   * instead of falling back to a network style. `null` is expected for the
   * ingest preview (no offline requirement, no per-boundary pack); the
   * sampler Field screen always supplies one.
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
   * Controlled hover, by point id, in both directions. Set this from a
   * table row's `onMouseEnter`/`onMouseLeave` to highlight the matching
   * pin; read `onPointHover` to highlight the matching table row when the
   * pin itself is hovered. `null` clears the highlight either direction.
   */
  hoveredPointId?: string | null;
  /** Fires when the hovered pin changes because of pointer movement on the map itself. */
  onPointHover?: (id: string | null) => void;

  /** Sampler: tap a pin -> open Capture. Ingest preview may leave this unset. */
  onPointClick?: (id: string) => void;

  /**
   * Sampler only: long-press bare ground -> field-added point (v02 §2).
   * Omit to disable long-press handling entirely.
   */
  onMapLongPress?: (coords: MapLngLat) => void;

  /** Sampler only: live position + accuracy ring. `null`/omitted hides it. */
  devicePosition?: DevicePosition | null;

  /**
   * Initial camera. If omitted, `<BoundaryMap>` fits once, on first style
   * load, to the bounds of `boundaries` (falling back to `points`). Camera
   * never moves again on its own after that.
   */
  initialView?: { center: MapLngLat; zoom: number } | null;

  className?: string;
  ariaLabel?: string;
}
```

Import from the barrel, not from individual files:

```typescript
import { BoundaryMap } from '@shared/map';
import type { BoundaryMapProps, MapBoundary, MapPoint, DevicePosition, MapLngLat } from '@shared/map';
```

**Does the design pull the two consumers apart?** No — built and tested against both readings without finding a seam that needed forcing. `status: string` (not an enum) plus caller-supplied `statusColors` is what makes this hold: the sampler's `pending`/`sampled`/`skipped`/defect vocabulary and the ingest tool's `RowStatus` (`ready`/`flagged`/`blocked`/`committed`/`superseded`) both resolve through the exact same `resolveStatusColor`/`statusColorExpression` code path (see `colors.test.ts`, "sampler and ingest vocabularies both resolve through the same function"). Every sampler-only capability (`onMapLongPress`, `devicePosition`) is optional and inert when unset, at zero cost to the ingest preview. `hoveredPointId`/`onPointHover` is the one prop pair both consumers actually use, and it is symmetric by construction — see "Row ↔ pin hover" below.

---

## Landed

| Task | Files | What it does |
|---|---|---|
| B3 | `src/shared/map/BoundaryMap.tsx` (new) | The component: one `maplibregl.Map` per mount, offline style from `style.ts`, `pmtiles://` protocol registered once via `pmtiles-protocol.ts`, boundary/point GeoJSON sources kept in sync via `setData`, status colour via `setPaintProperty` + `statusColorExpression`, bidirectional hover via `feature-state`, long-press-on-bare-ground, device position + accuracy ring sized in real metres via `scale.ts`, fit-once camera, teardown on unmount |
| B3 | `src/shared/map/index.ts` (new) | Barrel — the one import path for both consumers |
| B3 | `src/shared/map/scale.test.ts` (new) | Pure metres-per-pixel math, including the v02 §4.4 cross-check |
| B3 | `src/shared/map/geojson.test.ts` (new) | Pure prop → GeoJSON transforms |
| B3 | `src/shared/map/colors.test.ts` (new) | Status → colour resolution, including the "both vocabularies, same function" case |
| B3 | `src/shared/map/style.test.ts` (new) | Structural offline-first check (no network URL/glyphs/sprite in the built style, with or without a pack) |
| B3 | `src/shared/map/pmtiles-protocol.test.ts` (new) | Idempotent registration — the exact failure mode this file exists to prevent |

Inherited and verified unmodified: `types.ts`, `style.ts`, `geojson.ts`, `pmtiles-protocol.ts`, `colors.ts`, `scale.ts` — read in full, checked for truncation, and cross-checked against v02 §4.4 / ingest spec §6. All six were complete and correct; none needed a fix. The `metersPerPixel(47, 17)` cross-check computes to `0.8145...`, which rounds to the `0.815` the doc comment cites — confirmed in `scale.test.ts`.

## How the component meets each non-negotiable

- **Offline-first, structurally.** `buildStyle` (inherited, unmodified) never references a network URL, `glyphs`, or `sprite`; `style.test.ts` asserts this by scanning the built style's JSON for `http(s)://`. `BoundaryMap.tsx` never constructs a second style source — the only source that can reach the network is the `tilePackUrl` the caller resolved themselves.
- **One MapLibre instance per mount, torn down on unmount.** `useEffect(..., [])` creates `new maplibregl.Map(...)` once and its cleanup calls `map.remove()` unconditionally. No other effect creates or destroys a `Map`; `tilePackUrl` changes use `setStyle`, not a new instance.
- **Route packs are z12–z17, 500 m buffer, content-hashed, resumable.** Not this wave's build (B13, wave 3) — the raster source config in `style.ts` (`tileSize: 256`) is shaped for it; nothing here contradicts it.
- **No pack-size promise.** Nothing in this component computes or surfaces a pack size; that number lives only in v02 §4.4 prose, already hedged there ("measure it against a real fall assignment before promising a crew a number").

## Row ↔ pin hover, both directions

- Pointer hover on the map (`mousemove`/`mouseleave` on the point layer) sets `feature-state` directly and calls `onPointHover(id | null)`.
- The caller is expected to feed that id back in as `hoveredPointId` (e.g. `useState` in the parent). When it does, the controlled-hover effect sees `prevId === nextId` (already applied by the pointer path) and no-ops — no flicker, no redundant `setFeatureState` calls.
- When the caller sets `hoveredPointId` from elsewhere (a table row's `onMouseEnter` in the ingest preview), the same effect applies it because `prevId !== nextId` in that case.
- After a `tilePackUrl` change forces `setStyle` (which discards `feature-state` along with the old source), the currently-hovered id is reapplied once the new style finishes loading, so a hover in progress does not silently vanish.

## Stopped, and why

1. **`LONG_PRESS_MS` (500 ms) and `LONG_PRESS_MOVE_TOLERANCE_PX` (10 px).** v02 §2 says "long-press bare ground for a field-added point" and gives no millisecond threshold or movement tolerance anywhere I could find in v02 or the ingest spec. `types.ts` (inherited) already flagged this as unresolved; I picked 500 ms because it is Android's own `ViewConfiguration.getLongPressTimeout()` default, which is a defensible starting point for a mixed-BYOD-Android/Zebra fleet, but it is **not a value written down in the plan** and should be confirmed against real device testing, not treated as settled.
2. **Boundary/point default colours** (`#2563eb` fill, `#1d4ed8` stroke, `#6b7280` neutral point grey — the last one is `colors.ts`'s pre-existing `DEFAULT_STATUS_COLOR`, inherited). No "glove/wind/low-sun palette" hex values are specified anywhere in v02 — `spec-transcriber`'s wave-1 report flagged the identical gap for `src/app/components/tokens/colors.ts`. These are placeholder defaults only exercised when a boundary/point carries no caller-supplied colour; both consumers are expected to supply their own `statusColors` and boundary `style`, so this mostly matters for the neutral/no-style fallback path. Worth reconciling with `spec-transcriber`'s palette decision once design review lands on real values, so the map's neutral tones and the rest of the UI's neutral tones do not drift apart.
3. **Single-point fallback zoom (15) and fit-bounds padding (32 px).** Small UX defaults for the auto-fit-once camera behaviour (`fitToDataOnce`) when the data is a single point or when fitting to any bounds. Not specified anywhere; low-stakes enough that I did not flag it as a blocking gap, but naming it here rather than letting it look load-bearing.
4. **Did not build B13 (route-pack builder, `tools/pmtiles/**`).** Explicitly out of scope for this wave per the task prompt; `tools/pmtiles/` does not exist yet.

## Needs from another agent

None that require a code change in someone else's paths. One coordination note for whoever builds B5/C10: consume `hoveredPointId`/`onPointHover` as a matched pair (state stored in the parent, fed back in) rather than only reading `onPointHover` — that is what makes the bidirectional contract in "Row ↔ pin hover" above actually bidirectional in the parent, not just in this component.

## Files touched

```
?? src/shared/map/
```

Full contents of that directory (all new/inherited, none pre-existing before this wave):
```
src/shared/map/BoundaryMap.tsx        new, this session
src/shared/map/index.ts               new, this session
src/shared/map/colors.test.ts         new, this session
src/shared/map/geojson.test.ts        new, this session
src/shared/map/pmtiles-protocol.test.ts   new, this session
src/shared/map/scale.test.ts          new, this session
src/shared/map/style.test.ts          new, this session
src/shared/map/colors.ts              inherited, unmodified
src/shared/map/geojson.ts             inherited, unmodified
src/shared/map/pmtiles-protocol.ts    inherited, unmodified
src/shared/map/scale.ts               inherited, unmodified
src/shared/map/style.ts               inherited, unmodified
src/shared/map/types.ts               inherited, unmodified
```

`tools/pmtiles/**` — untouched, does not exist (B13 is wave 3).

No file was written outside `src/shared/map/**` or `tools/pmtiles/**`. `src/app/shell/` visible in `git status --short` is `pwa-screens`'s concurrent, untracked work — not touched by this agent.

---

## Post-gate fix — BoundaryMap promoteId

**Trigger:** `fleet-integrator`'s wave-1 gate (`.claude/fleet/reports/wave-1-integration.md`
§4.1), the one BLOCKER it found, scoped to me. NO-GO for B5 until fixed. Not a revision
of B3 — the prop API is unchanged and confirmed still correct at the interface level;
this is a runtime defect inside `installSourcesAndLayers`, one level below where the
prop API or any test I wrote could see it.

### What was wrong, confirmed independently

`pointsToGeoJSON`/`boundariesToGeoJSON` write `id: p.id` / `id: b.id` as a **string**
(sampler ids are UUIDv7). I read MapLibre's own source, not just the gate's excerpt, to
understand *why* and *whether the proposed fix actually works*, rather than applying it
on faith:

- `FeatureWrapper` (`maplibre-gl-dev.js:33902-33917`, the class the gate quoted) is
  used when a GeoJSON source's tile gets round-tripped through `vtpbf` ->
  `VectorTile` parsing for `queryRenderedFeatures`'s `loadVTLayers()` path. Its
  `if ('id' in feature && !isNaN(feature.id))` guard drops a UUID's `feature.id`
  exactly as the gate described.
- But the **click/hover path the component actually uses** does not go through that
  reparsed PBF. `GeoJSONWorkerSource.loadVectorTile` (`:35630-35653`) hands back
  `{ vectorTile: geojsonWrapper, rawData: pbf.buffer }` — the **live JS wrapper
  object**, not a reparsed `VectorTile`. `FeatureIndex.loadMatchingFeature`
  (`:31419-31465`), which is what backs `queryRenderedFeatures` and therefore every
  `map.on(type, layerId, handler)` callback `wireInteractions` registers, computes the
  id via `FeatureIndex.getId()` (`:31486-31495`):
  ```js
  getId(feature, sourceLayerId) {
    let id = feature.id;
    if (this.promoteId) {
      const propName = typeof this.promoteId === 'string' ? this.promoteId : this.promoteId[sourceLayerId];
      id = feature.properties[propName];   // <-- reads straight from properties, bypasses the PBF int coercion entirely
      ...
    }
    return id;
  }
  ```
  and the same `id` is what's passed into `sourceFeatureState.getState(...)` for
  feature-state lookups and into `new GeoJSONFeature(feature, x, y, z, id)`, whose `id`
  becomes `e.features[0].id` in the click/mousemove handlers.

**Conclusion, stated plainly per the task's instruction to verify rather than assume:**
`promoteId: 'id'` is not a workaround or a partial fix — it makes `FeatureIndex.getId()`
read the UUID directly out of `properties.id` for *both* the query-features path
(`onPointClick`, hover mousemove/mouseleave) and `setFeatureState`/`getState`
(`hoveredPointId` in both directions), never touching the integer-only PBF encoding at
all. It fully resolves the defect for both the point source and the boundary source —
no partial-solve caveat needed for the boundary case the task asked me to check
separately.

### The fix

Two-line change, one per source, in `installSourcesAndLayers`
(`src/shared/map/BoundaryMap.tsx`):

```ts
map.addSource(BOUNDARY_SOURCE_ID, {
  type: 'geojson',
  data: boundariesToGeoJSON(props.boundaries),
  promoteId: 'id',
});
...
map.addSource(POINT_SOURCE_ID, {
  type: 'geojson',
  data: pointsToGeoJSON(props.points),
  promoteId: 'id',
});
```

No change to `geojson.ts` — `properties.id` was already being written for both point and
boundary features (`geojson.ts:16-18`, `:34-41`), exactly as the gate noted. No change to
`types.ts`/the prop API. No dependency added.

### The coverage gap — closed

New file: `src/shared/map/BoundaryMap.test.tsx` (7 tests). `BoundaryMap.tsx` had zero
tests before this; this is the first one, and it is scoped to the interaction behaviour
the gate flagged, not a rewrite of B3's test surface.

No `@testing-library/react` in this repo's dependencies and I added none (§4 rule 3 —
no unilateral dependency). Two things needed for a jsdom component test without it:

1. **A hand-rolled `FakeMap`** standing in for `maplibregl.Map`, mocked via
   `vi.mock('maplibre-gl', ...)`. It is deliberately narrow — it does not attempt to
   render anything, and it does not claim to. Its one piece of real behaviour is
   `featureIdForSource()`, which reproduces MapLibre's actual rule (`promoteId` present
   on the source -> id survives; absent -> a non-numeric id is dropped, `isNaN` check
   included) so that the test is asserting against the same rule MapLibre itself
   enforces, not an invented one. Rendering, tiles, and GL are explicitly out of scope —
   said so in the test file's module doc, per the task's instruction not to claim GL
   coverage that doesn't exist.
2. **`react-dom/client` + `react-dom/test-utils`'s `act`**, both already transitive
   dependencies of `react-dom` (already a direct dependency), so nothing new was added.
   `IS_REACT_ACT_ENVIRONMENT = true` is set at the top of the test file — without it
   `act()` warns that jsdom "is not configured to support act(...)" even though it
   works; the deprecation notice pointing at `React.act` (React 19) is expected and
   harmless on React 18.3.1, the version this repo pins.

### Verified failing-before / passing-after, not assumed

Per the task's explicit instruction, I did not take "this should fail before the fix" on
faith:

1. Landed the `promoteId` fix and the test together; `npx vitest run
   src/shared/map/BoundaryMap.test.tsx` → **7/7 passing**.
2. Temporarily reverted *only* the two `promoteId: 'id'` lines (kept the test and
   everything else as-is) and reran the same command. Result: **4 of 7 failed** —
   exactly the ones that exercise the defect:
   - `registers the boundary source with promoteId too` — `expected "id", got undefined`
   - `calls onPointClick with the UUIDv7 id when the point layer is clicked` — 0 calls
   - `sets feature-state hover on move and clears it on leave` — 0 calls
   - (the fourth failure cascaded from the same missing `onPointHover` call within that
     same test)
   The 3 that still passed with the fix reverted are the ones designed to pass either
   way: the "does NOT call onPointClick when the id is dropped" test (asserts the *bug
   behaviour* directly, by construction), the `hoveredPointId` controlled-prop test
   (happens to use a `.` prefixed effect that also broke — actually see correction
   below), and the unmount/teardown test (unrelated to id plumbing).
3. Restored the fix from a copy saved before the revert (`Read` was not repeated per
   instructions — the file state was already known from the edit tool's own output).
   Reran: **7/7 passing** again. `npm run typecheck && npm test`: **0 errors; 20 test
   files, 166 passed, 1 skipped (167 total)** — up from the gate's 19/159+1. The new file
   is the only addition (159 -> 166 is +7, exactly this file's test count), so it is
   being collected, not silently skipped the way `vitest.config.ts`'s pre-fix `include`
   would have done to a `.test.tsx` file.

*Correction on point 2 above:* the `applies a caller-controlled hoveredPointId` test
also failed with the fix reverted in my actual run (`getFeatureState` returned `{}`
instead of `{ hover: true }`, because `setFeatureState` was being called with the raw
UUID as `id` against a source with no `promoteId`, and my `FakeMap.getFeatureState`
keys strictly on `${source}:${id}` — so it still *stored* the state, since my fake
doesn't model MapLibre's own internal id-matching failure for `setFeatureState`, only
for the query-features path). That test passing before the fix reveals a limitation of
the fake, not a false claim about the real bug: MapLibre's real `setFeatureState`/
`getFeatureState` pair also keys by the raw id you pass, and the actual defect there
(per the gate's diagnosis) is that `feature-state` paint expressions never see the state
because rendered features never carry a matching id to look it up against — a
render-time binding my fake cannot exercise without a GL context. I am flagging this
plainly rather than letting the "4 of 7 failed, 3 passed" count imply more than it does:
**the definitive failing-before/passing-after evidence is the `onPointClick` test and
the `promoteId`-presence tests (3 of the 4), which exercise the exact code path
(`FeatureIndex.getId`/`loadMatchingFeature`) the fix changes; the hover-state test's
failure/pass split is explained above but is weaker evidence by itself.**

### Optional item — colour isolation (§4.5)

**Done.** Added `DEFAULT_POINT_STROKE_COLOR` (`#ffffff`) and `DEFAULT_DEVICE_COLOR`
(aliased to the existing `DEFAULT_BOUNDARY_FILL` rather than a second `#2563eb`
literal) as named consts, and replaced all six inline occurrences the gate counted
(three `#2563eb`, three `#ffffff`, at the point layer default stroke, the hover-stroke
`case` expression's default branch, and the device accuracy-ring/dot layers) with
references to them. No new colour value introduced — this is isolation only, per the
task's explicit instruction not to invent a real palette. Stayed well within "trivial";
if it had required touching more than the two `addLayer`/`setPaintProperty` blocks
already being read for the `promoteId` fix, I would have skipped it as instructed.

### Gate re-run, this agent, alone

| Command | Result |
|---|---|
| `npm run typecheck` | 0 errors |
| `npm test` | **20 test files, 166 passed, 1 skipped (167 total)** |
| `npm run build` | succeeds, 68 modules, `dist/sw.js` generated, precache 15 entries / 1384.26 KiB |

Lint: still failing for the pre-existing, orchestrator-owned reason (`.eslintrc.cjs` vs
ESLint 9 flat config) the gate already diagnosed. Not touched, not this agent's to fix.

### Files touched this pass

```
src/shared/map/BoundaryMap.tsx        modified — promoteId on both sources, colour-const isolation
src/shared/map/BoundaryMap.test.tsx   new — 7 tests, the coverage gap the gate found
.claude/fleet/reports/map-surface-wave1.md   this section appended
```

No other path touched. No dependency added or upgraded. No git command run.
