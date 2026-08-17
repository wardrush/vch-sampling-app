/**
 * Screen 5 · Outbox (v02 §2). Placeholder for B1 — real content is B11, wave 2.
 *
 * `OutboxStore`/`OutboxWorker` (`src/sync/**`, `sync-spine`'s A3) are already
 * real — this screen's job in wave 2 is to read `OutboxStore.counts()` and
 * per-record `last_error`, and to call `OutboxWorker.drain({ force: true })`
 * on the manual sync button. Nothing here should be a spinner (v02 §2 / this
 * agent's non-negotiables).
 */

import { ScreenPlaceholder } from '@app/shell/ScreenPlaceholder.js';

export function OutboxScreen() {
  return (
    <ScreenPlaceholder
      name="Outbox"
      screenNumber={5}
      owner="pwa-screens (B11, wave 2)"
      note="Pending records, pending photo MB, last sync, manual sync, per-record failure reasons — a screen, not a spinner."
    />
  );
}
