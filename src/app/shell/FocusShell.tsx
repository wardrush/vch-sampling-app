/**
 * B1 — the distraction-free layout for Field, Capture and Skip.
 *
 * No bottom nav: `routes.ts` explains the reasoning. Still carries the SW
 * update banner (a sampler deserves to know a new version is ready no matter
 * which screen they're on) and the error boundary (a crashed Capture screen
 * must not strand a sampler with no way back to Today).
 */

import { Outlet } from 'react-router-dom';
import { SEMANTIC_COLORS } from '@app/components/tokens/index.js';
import { UpdateBanner } from './UpdateBanner.js';
import { ErrorBoundary } from './ErrorBoundary.js';

export function FocusShell() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100%',
        background: SEMANTIC_COLORS.bgPrimary,
      }}
    >
      <UpdateBanner />
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}
