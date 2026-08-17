/**
 * B1 — the distraction-free layout for Field, Capture and Skip.
 *
 * No bottom nav: `routes.ts` explains the reasoning. Still carries the SW
 * update banner (a sampler deserves to know a new version is ready no matter
 * which screen they're on) and the error boundary (a crashed Capture screen
 * must not strand a sampler with no way back to Today).
 *
 * **`height: '100%'`, not `minHeight` — this is load-bearing, not cosmetic.**
 * `AppShell` uses `minHeight: '100%'` safely because Today/Outbox/Storage
 * scroll at the page level (`AppShell`'s own `main` has `overflowY: 'auto'`)
 * and none of them need a percentage-height descendant. Every screen under
 * *this* shell does the opposite: `CaptureScreen`/`SkipScreen` already carry
 * their own internal `flex: 1; overflowY: 'auto'` content region assuming a
 * fixed-height viewport, and `FieldScreen`'s map area is `flex: 1` inside a
 * `height: '100%'` column feeding `<BoundaryMap>`'s own root div, which is
 * `width/height: 100%` (`src/shared/map/BoundaryMap.tsx`, not this agent's
 * file). CSS percentage heights only resolve against a containing block with
 * an explicit (not auto-with-a-floor) height — `min-height: 100%` sets a
 * lower bound on an otherwise content-sized box, which is not the same
 * thing, and the practical result was `<BoundaryMap>`'s container
 * (`.maplibregl-map`) resolving to `clientHeight: 0` while its canvas kept
 * whatever size MapLibre had last measured: the map initialised, sized
 * itself correctly once, and then had nowhere to actually paint. `height:
 * '100%'` here (matching `#root`'s own `height: 100%` in
 * `src/app/styles/global.css`) is what the whole downstream chain already
 * assumed; `minHeight` here was the one broken link. `main` additionally
 * gets `minHeight: 0` — the standard fix for a flex item's default `auto`
 * min-height otherwise refusing to shrink below its content, which is what
 * lets `CaptureScreen`/`SkipScreen`'s own inner scroll regions actually
 * scroll instead of blowing out this shell.
 */

import { Outlet } from 'react-router-dom';
import { SEMANTIC_COLORS } from '@app/components/tokens/index.js';
import { UpdateBanner } from './UpdateBanner.js';
import { MemoryFallbackBanner } from './MemoryFallbackBanner.js';
import { ErrorBoundary } from './ErrorBoundary.js';

export function FocusShell() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: SEMANTIC_COLORS.bgPrimary,
      }}
    >
      <UpdateBanner />
      <MemoryFallbackBanner />
      <main style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}
