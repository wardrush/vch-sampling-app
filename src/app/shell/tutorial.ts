/**
 * B14 — v02 §4.5 / D18: "First run … ends by setting a server-side
 * `tutorial_completed_ts`… Skipping the tutorial still sets the flag."
 *
 * **The server side does not exist yet.** `netlify.toml` declares no route
 * for it, there is no function file, and D17's phased auth means there is no
 * durable per-device identity to hang a server-side flag on regardless (the
 * MVP has a session cookie post-login, not yet a soft device identity this
 * screen could call before then). Rather than invent an endpoint path no
 * server implements — the exact guess-past-a-gap `FLEET.md` §4 rule 6 asks
 * agents not to make — this module does the honest fallback the task asked
 * for: it persists locally (so a device does not re-teach an experienced
 * user on this device) and best-effort attempts the server call, silently
 * accepting that today it always fails. See the wave-3 report for what a
 * real implementation needs: a `POST` this app can reach with the device's
 * soft identity attached, once one exists.
 */

import { getOrCreateDeviceId } from './device-id.js';

const STORAGE_KEY = 'vch_sampler_tutorial_completed_ts';

/** `null` before the first run completes or skips. */
export function getTutorialCompletedTs(): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
  } catch {
    // Storage disabled (private mode with storage blocked, quota) — treated
    // as "never completed", which means the tutorial shows every load. That
    // is the safe direction to fail in: re-showing a brief tutorial costs a
    // few seconds, silently skipping it costs a lesson.
    return null;
  }
}

export interface TutorialCompletionResult {
  completed_ts: string;
  /** Whether the (best-effort, currently unimplemented) server call answered. */
  persisted_server_side: boolean;
}

/**
 * Marks the tutorial done — reached by finishing it or by tapping Skip,
 * identically (v02 §4.5: "An adult who skips a tutorial has made a
 * decision"). Local storage is written first and is the source of truth for
 * this device; the server attempt is best-effort and never blocks or throws.
 */
export async function markTutorialCompleted(): Promise<TutorialCompletionResult> {
  const completed_ts = new Date().toISOString();

  try {
    localStorage.setItem(STORAGE_KEY, completed_ts);
  } catch {
    // See getTutorialCompletedTs — nothing further to do locally.
  }

  let persisted_server_side = false;
  try {
    const res = await fetch('/v1/device/tutorial-complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ device_id: getOrCreateDeviceId(), tutorial_completed_ts: completed_ts }),
    });
    persisted_server_side = res.ok;
  } catch {
    // No such endpoint exists yet (see module header) — local persistence is
    // the honest fallback, not an error to surface to the sampler.
  }

  return { completed_ts, persisted_server_side };
}

/** Test/dev escape hatch. */
export function _resetTutorialCompletionForTests(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
}
