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
 * B10/B12 (wave 2): Skip and Storage screens now import from `screens/skip/**`
 * and `screens/storage/**`. Both screens are real (spec-transcriber, wave 2).
 *
 * B14 (wave 3): `screens/tutorial/**` — the first-run guided walkthrough
 * (v02 D18). Lives under `FocusShell` (no bottom nav — full attention,
 * nothing to jump away to mid-walkthrough) even though it is reached from
 * Today, the same reasoning `routes.ts` gives for Field/Capture/Skip.
 */

import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { DeviceDbProvider } from './shell/db/DeviceDbProvider.js';
import { AppShell } from './shell/AppShell.js';
import { FocusShell } from './shell/FocusShell.js';
import { ROUTE_PATHS } from './shell/routes.js';
import { TodayScreen } from './screens/today/TodayScreen.js';
import { FieldScreen } from './screens/field/FieldScreen.js';
import { CaptureScreen } from './screens/capture/CaptureScreen.js';
import { OutboxScreen } from './screens/outbox/OutboxScreen.js';
import { SkipScreen } from './screens/skip/SkipScreen.js';
import { StorageScreen } from './screens/storage/StorageScreen.js';
import { TutorialScreen } from './screens/tutorial/TutorialScreen.js';

export function App() {
  return (
    <DeviceDbProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route path={ROUTE_PATHS.today} element={<TodayScreen />} />
            <Route path={ROUTE_PATHS.outbox} element={<OutboxScreen />} />
            <Route path={ROUTE_PATHS.storage} element={<StorageScreen />} />
          </Route>

          <Route element={<FocusShell />}>
            <Route path={ROUTE_PATHS.field} element={<FieldScreen />} />
            <Route path={ROUTE_PATHS.capture} element={<CaptureScreen />} />
            <Route path={ROUTE_PATHS.captureNew} element={<CaptureScreen />} />
            <Route path={ROUTE_PATHS.skip} element={<SkipScreen />} />
            <Route path={ROUTE_PATHS.tutorial} element={<TutorialScreen />} />
          </Route>

          <Route path="*" element={<Navigate to={ROUTE_PATHS.today} replace />} />
        </Routes>
      </BrowserRouter>
    </DeviceDbProvider>
  );
}
