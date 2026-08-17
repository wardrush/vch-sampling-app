/**
 * Retry backoff. SYNC_CONTRACT_v01 §3.
 *
 * 5 s, 30 s, 2 min, 10 min, 1 h, then hourly. Jittered. **Reset on any
 * successful batch.**
 *
 * Backoff is a property of the *connection*, not of a record: one gas-station
 * signal that works means everything queued should go now, not on each row's
 * own private timer. Per-record `attempt_count` is still kept, but for the
 * sampler's benefit — it is what turns "stuck" into "tried nine times, last
 * error was X" on the Outbox screen.
 */

import { BACKOFF_SCHEDULE_MS } from '../shared/contract/sync.js';

/** ±20%. Enough to keep a crew of six phones off the same second. */
const JITTER_FRACTION = 0.2;

export function backoffDelayMs(
  consecutiveFailures: number,
  random: () => number = Math.random,
): number {
  if (consecutiveFailures <= 0) return 0;
  const idx = Math.min(consecutiveFailures - 1, BACKOFF_SCHEDULE_MS.length - 1);
  const base = BACKOFF_SCHEDULE_MS[idx]!;
  const jitter = base * JITTER_FRACTION * (random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}
