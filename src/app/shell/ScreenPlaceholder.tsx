/**
 * B1 — the placeholder every one of the six routes renders until its real
 * screen lands (wave 2: B4 Today, B5 Field, B7 barcode wiring, B10 Skip, B11
 * Outbox, B12 Storage). Deliberately generic rather than six bespoke stub
 * components — the point of this wave is that the route, not the content,
 * exists.
 *
 * Shows live device-database status so "OPFS + wa-sqlite bootstrap is real
 * and initialises" (this wave's definition of done) is something a reviewer
 * can *see* on any of the six routes, not just take on faith from the code.
 */

import type { JSX } from 'react';
import { SEMANTIC_COLORS, SPACING, FONT_SIZES } from '@app/components/tokens/index.js';
import { Badge } from '@app/components/index.js';
import { useDeviceDb } from './db/DeviceDbProvider.js';

export interface ScreenPlaceholderProps {
  /** e.g. "Today", "Skip". Matches v02 §2's screen names. */
  name: string;
  screenNumber: number;
  /** Which agent/task builds the real content, and when. */
  owner: string;
  note?: string;
}

export function ScreenPlaceholder({
  name,
  screenNumber,
  owner,
  note,
}: ScreenPlaceholderProps): JSX.Element {
  const dbState = useDeviceDb();

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: SPACING.lg,
        padding: SPACING.xl,
        color: SEMANTIC_COLORS.textPrimary,
      }}
    >
      <div>
        <div style={{ fontSize: FONT_SIZES['2xl'], fontWeight: 700 }}>
          {screenNumber} · {name}
        </div>
        <div style={{ fontSize: FONT_SIZES.base, color: SEMANTIC_COLORS.textSecondary }}>
          Route wired by <code>pwa-screens</code> (B1). Screen content owned by{' '}
          <code>{owner}</code>.{note ? ` ${note}` : ''}
        </div>
      </div>

      <DeviceDbStatus state={dbState} />
    </div>
  );
}

function DeviceDbStatus({ state }: { state: ReturnType<typeof useDeviceDb> }): JSX.Element {
  if (state.status === 'loading') {
    return <Badge label="Device database opening…" status="neutral" />;
  }
  if (state.status === 'error') {
    return <Badge label={`Device database unavailable: ${state.error.message}`} status="error" />;
  }
  return (
    <Badge
      label={`Device database ready — schema v${state.migration.to}${
        state.migration.applied.length > 0 ? ` (applied ${state.migration.applied.join(', ')})` : ''
      }`}
      status="success"
    />
  );
}
