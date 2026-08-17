/**
 * Screen 1 · Today (v02 §2). Placeholder for B1 — real content is B4, wave 2.
 */

import { ScreenPlaceholder } from '@app/shell/ScreenPlaceholder.js';

export function TodayScreen() {
  return (
    <ScreenPlaceholder
      name="Today"
      screenNumber={1}
      owner="pwa-screens (B4, wave 2)"
      note="Assigned boundaries, progress rings, outbox count, bundle expiry. 'Yesterday's flags' stays behind a feature flag, off in v1."
    />
  );
}
