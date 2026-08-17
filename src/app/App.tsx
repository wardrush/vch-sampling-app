/**
 * B1 — app root: device DB bootstrap → router → the six screens.
 *
 * `DeviceDbProvider` sits above the router because Today, Field, Outbox and
 * Storage all need local state and none of them should re-implement "is the
 * database open yet" — see `shell/db/DeviceDbProvider.tsx`.
 *
 * Two layout routes, not one: `AppShell` (persistent bottom nav — Today,
 * Outbox, Storage) and `FocusShell` (no nav — Field, Capture, Skip). Reasoning
 * is in `shell/routes.ts`.
 *
 * Skip and Storage render `ScreenPlaceholder` directly rather than importing
 * from `screens/skip/**`/`screens/storage/**`, because those trees do not
 * exist yet this wave (`spec-transcriber`'s B10/B12 are wave 2) — a static
 * import of a path that doesn't exist would fail `npm run typecheck` today.
 * **Follow-up for `pwa-screens` once B10/B12 land:** swap these two `<Route>`
 * elements to import the real components. This file is the only place that
 * needs to change; `screens/skip/**` and `screens/storage/**` themselves are
 * never touched by this agent.
 */

import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { DeviceDbProvider } from './shell/db/DeviceDbProvider.js';
import { AppShell } from './shell/AppShell.js';
import { FocusShell } from './shell/FocusShell.js';
import { ScreenPlaceholder } from './shell/ScreenPlaceholder.js';
import { ROUTE_PATHS } from './shell/routes.js';
import { TodayScreen } from './screens/today/TodayScreen.js';
import { FieldScreen } from './screens/field/FieldScreen.js';
import { CaptureScreen } from './screens/capture/CaptureScreen.js';
import { OutboxScreen } from './screens/outbox/OutboxScreen.js';

export function App() {
  return (
    <DeviceDbProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route path={ROUTE_PATHS.today} element={<TodayScreen />} />
            <Route path={ROUTE_PATHS.outbox} element={<OutboxScreen />} />
            <Route
              path={ROUTE_PATHS.storage}
              element={
                <ScreenPlaceholder
                  name="Storage"
                  screenNumber={6}
                  owner="spec-transcriber (B12, wave 2)"
                  note="Used, free, and 'reclaim uploaded photos.'"
                />
              }
            />
          </Route>

          <Route element={<FocusShell />}>
            <Route path={ROUTE_PATHS.field} element={<FieldScreen />} />
            <Route path={ROUTE_PATHS.capture} element={<CaptureScreen />} />
            <Route path={ROUTE_PATHS.captureNew} element={<CaptureScreen />} />
            <Route
              path={ROUTE_PATHS.skip}
              element={
                <ScreenPlaceholder
                  name="Skip"
                  screenNumber={4}
                  owner="spec-transcriber (B10, wave 2)"
                  note="Reason code, optional photo, optional note."
                />
              }
            />
          </Route>

          <Route path="*" element={<Navigate to={ROUTE_PATHS.today} replace />} />
        </Routes>
      </BrowserRouter>
    </DeviceDbProvider>
  );
}
