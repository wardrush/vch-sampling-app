/**
 * B1 — service worker update surface.
 *
 * **Strategy, and why:** `vite.config.ts` registers the PWA plugin with
 * `registerType: 'prompt'` (not `autoUpdate`) — a sampler mid-capture must
 * never have the app silently swap its JS out from under an open form.
 * `injectRegister: null` means nothing self-registers; this component is the
 * one call to `virtual:pwa-register/react`'s `useRegisterSW`, and it is
 * mounted once at the shell root so it runs regardless of which of the six
 * screens is showing.
 *
 * Precache scope, deliberately narrow (see `vite.config.ts`'s
 * `workbox.globPatterns`): JS/CSS/HTML/icons/manifest only. Photo bytes and
 * PMTiles route packs are **never** in the service-worker cache — they are
 * OPFS's job (`wa-sqlite-opfs.ts` / the future PMTiles store), which is what
 * keeps a multi-hundred-MB route pack from being re-fetched or evicted by a
 * cache the app does not control the eviction policy of.
 *
 * Update flow: the banner appears only once a new version has finished
 * downloading in the background (`onNeedRefresh`) — never mid-download, never
 * as a blocking modal. "Later" dismisses for this session; the next full
 * reload (end of day, phone restart) picks up the new version regardless,
 * because the waiting worker activates on next navigation once no client
 * holds the old one open.
 */

import { useState, type CSSProperties } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { SEMANTIC_COLORS, SPACING, Z_INDEX } from '@app/components/tokens/index.js';
import { Button } from '@app/components/index.js';

export function UpdateBanner() {
  const [dismissed, setDismissed] = useState(false);
  const {
    needRefresh: [needRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError(error) {
      // Registration failure must never block the app — it just means the
      // next launch without connectivity won't have this version cached yet.
      // eslint-disable-next-line no-console
      console.error('Service worker registration failed', error);
    },
  });

  if (needRefresh && !dismissed) {
    return (
      <div style={bannerStyle(SEMANTIC_COLORS.chipInfoBg)}>
        <span>An updated version has downloaded and is ready.</span>
        <div style={{ display: 'flex', gap: SPACING.sm }}>
          <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
            Later
          </Button>
          <Button size="sm" onClick={() => updateServiceWorker(true)}>
            Update now
          </Button>
        </div>
      </div>
    );
  }

  if (offlineReady) {
    return (
      <div style={bannerStyle(SEMANTIC_COLORS.chipSuccessBg)}>
        <span>Ready to work offline.</span>
        <Button size="sm" variant="ghost" onClick={() => setOfflineReady(false)}>
          Dismiss
        </Button>
      </div>
    );
  }

  return null;
}

function bannerStyle(background: string): CSSProperties {
  return {
    position: 'sticky',
    top: 0,
    zIndex: Z_INDEX.notification,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.md,
    padding: `${SPACING.sm} ${SPACING.lg}`,
    background,
    color: SEMANTIC_COLORS.textInverse,
    fontSize: 15,
  };
}
