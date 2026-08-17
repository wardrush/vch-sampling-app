/**
 * B1 (wave 3) — the honest indicator required alongside the memory-VFS
 * fallback (`wa-sqlite-opfs.ts`'s header). When the persistent (IndexedDB)
 * database could not be opened and the driver fell back to `MemoryAsyncVFS`,
 * a sampler must never be left believing a day's work is stored when it is
 * not — the same reasoning v02 §2 gives for the Outbox being a screen and
 * not a spinner.
 *
 * Rendered in both `AppShell` and `FocusShell` so it is visible on every
 * screen, Capture included, not just the ones with a bottom nav — and it is
 * not dismissible: the moment it stops being true is the moment the
 * database reopens on a persistent backend (a fresh load), not a tap.
 */

import { SEMANTIC_COLORS, SPACING, FONT_WEIGHTS } from '@app/components/tokens/index.js';
import { useDeviceDb } from './db/DeviceDbProvider.js';

export function MemoryFallbackBanner() {
  const state = useDeviceDb();
  if (state.status !== 'ready' || state.backend !== 'memory') return null;

  return (
    <div
      role="alert"
      style={{
        padding: `${SPACING.sm} ${SPACING.lg}`,
        background: SEMANTIC_COLORS.chipErrorBg,
        color: SEMANTIC_COLORS.chipErrorText,
        fontWeight: FONT_WEIGHTS.bold,
        fontSize: 13,
        textAlign: 'center',
      }}
    >
      Not saving to this device — this browser could not open a persistent database, so anything
      captured now is lost when this tab closes. Reload in a normal (non-private) browser tab
      before relying on this for real work.
    </div>
  );
}
