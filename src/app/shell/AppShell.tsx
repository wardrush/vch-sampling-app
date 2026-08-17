/**
 * B1 — the persistent shell: brand bar + bottom nav + SW update banner +
 * error boundary, wrapping Today / Outbox / Storage (`routes.ts`'s design
 * note explains why Field / Capture / Skip use `FocusShell` instead).
 *
 * Bottom nav, not a hamburger or a top tab bar: three destinations, reachable
 * one-handed with the phone held low (v02 §2/§4.3 — gloves, wind, a thumb,
 * not a stylus), and each target is comfortably above the 48 dp floor.
 *
 * Brand pass: a slim top bar carries the mark so the app reads as Veteran's
 * Carbon Holdings the instant it opens, without competing with capture for
 * screen space — it is deliberately absent from `FocusShell`, where every
 * pixel of vertical room goes to the map or the form.
 */

import { NavLink, Outlet } from 'react-router-dom';
import { SEMANTIC_COLORS, SPACING, TOUCH_TARGETS, FONT_WEIGHTS } from '@app/components/tokens/index.js';
import { NAV_DESTINATIONS } from './routes.js';
import { UpdateBanner } from './UpdateBanner.js';
import { MemoryFallbackBanner } from './MemoryFallbackBanner.js';
import { ErrorBoundary } from './ErrorBoundary.js';

export function AppShell() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100%',
        background: SEMANTIC_COLORS.bgPrimary,
      }}
    >
      <BrandBar />
      <UpdateBanner />
      <MemoryFallbackBanner />
      <main style={{ flex: 1, overflowY: 'auto', paddingBottom: TOUCH_TARGETS.xlarge }}>
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </main>
      <BottomNav />
    </div>
  );
}

function BrandBar() {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: SPACING.sm,
        padding: `${SPACING.sm} ${SPACING.lg}`,
        paddingTop: `calc(${SPACING.sm} + env(safe-area-inset-top))`,
        background: SEMANTIC_COLORS.bgInverse,
        color: SEMANTIC_COLORS.textInverse,
      }}
    >
      <img
        src="/icons/icon-192.png"
        alt=""
        width={28}
        height={28}
        style={{ borderRadius: 6, flexShrink: 0 }}
      />
      <span style={{ fontSize: 16, fontWeight: FONT_WEIGHTS.bold, letterSpacing: 0.2 }}>
        Veteran&rsquo;s Carbon Holdings
      </span>
    </header>
  );
}

function BottomNav() {
  return (
    <nav
      aria-label="Primary"
      style={{
        position: 'sticky',
        bottom: 0,
        display: 'flex',
        // Safe-area inset so the nav clears a phone's home-indicator/gesture
        // bar rather than sitting under it.
        paddingBottom: 'env(safe-area-inset-bottom)',
        borderTop: `1px solid ${SEMANTIC_COLORS.borderDefault}`,
        background: SEMANTIC_COLORS.bgPrimary,
        boxShadow: `0 -2px 8px ${SEMANTIC_COLORS.shadowMedium}`,
      }}
    >
      {NAV_DESTINATIONS.map((dest) => (
        <NavLink
          key={dest.key}
          to={dest.path}
          end={dest.path === '/'}
          style={({ isActive }) => ({
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: TOUCH_TARGETS.xlarge, // 64 dp — well above the 48 dp floor
            fontSize: 16,
            fontWeight: isActive ? FONT_WEIGHTS.bold : FONT_WEIGHTS.medium,
            color: isActive ? SEMANTIC_COLORS.buttonPrimaryBg : SEMANTIC_COLORS.textSecondary,
            textDecoration: 'none',
          })}
        >
          {dest.label}
        </NavLink>
      ))}
    </nav>
  );
}
