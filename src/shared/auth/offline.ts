/**
 * A11 — the offline device session. Contract §7, plan v02 §8.
 *
 * A BYOD device offline for days cannot re-authenticate, so the shape is
 * different from the office side:
 *
 *  - **Enrolment happens online, once.** The device is bound to a person and a
 *    crew org, and gets an `offline_valid_until` hard stop.
 *  - **Unlock is per app open, never per capture.** A sampler with cold, muddy
 *    hands re-authenticating at every hole will find a workaround, and the
 *    workaround will be paper.
 *  - **Revocation is a sync-time refusal plus a self-wipe instruction.** A
 *    phone that never comes back online cannot be wiped. Say that in the crew
 *    agreement rather than implying remote wipe works on a device that is off.
 *    The mitigation is the bounded window and the fact that the only person
 *    data on the device is a contact name and phone for assigned properties.
 *
 * The window is **configuration, not a constant** — 14 days, tunable to 10
 * after the first season (addendum §1). It should not go to 2: designing for
 * nightly sync means designing *against* multi-day offline, and buying the
 * slack back later costs a season.
 */

export const DEFAULT_OFFLINE_WINDOW_DAYS = 14;
export const MIN_OFFLINE_WINDOW_DAYS = 7;

export interface OfflineSessionConfig {
  offlineWindowDays?: number;
}

export interface DeviceEnrolment {
  device_id: string;
  sampler_person_id: string;
  crew_org_id: string;
  platform: string | null;
  device_model: string | null;
  manufacturer: string | null;
  os_version: string | null;
  app_version: string | null;
  user_agent_raw: string | null;
}

export interface OfflineSession {
  device_id: string;
  sampler_person_id: string;
  crew_org_id: string;
  offline_valid_until: string;
}

export function offlineWindowDays(config: OfflineSessionConfig = {}): number {
  const requested = config.offlineWindowDays ?? DEFAULT_OFFLINE_WINDOW_DAYS;
  // A configuration slip that shortens this to a day or two would strand a
  // crew mid-deployment, which is the exact failure the window exists to
  // prevent. Refuse the value rather than shipping it.
  return Math.max(MIN_OFFLINE_WINDOW_DAYS, requested);
}

export function issueOfflineSession(
  enrolment: Pick<DeviceEnrolment, 'device_id' | 'sampler_person_id' | 'crew_org_id'>,
  config: OfflineSessionConfig = {},
  nowMs = Date.now(),
): OfflineSession {
  const days = offlineWindowDays(config);
  return {
    device_id: enrolment.device_id,
    sampler_person_id: enrolment.sampler_person_id,
    crew_org_id: enrolment.crew_org_id,
    offline_valid_until: new Date(nowMs + days * 86_400_000).toISOString(),
  };
}

export type OfflineState =
  | { state: 'valid'; daysRemaining: number }
  | { state: 'warn'; daysRemaining: number }
  | { state: 'locked' };

/** Warns at three days out; hard-stops at expiry. */
export function offlineSessionState(
  session: Pick<OfflineSession, 'offline_valid_until'>,
  nowMs = Date.now(),
): OfflineState {
  const remainingMs = new Date(session.offline_valid_until).getTime() - nowMs;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return { state: 'locked' };
  const daysRemaining = remainingMs / 86_400_000;
  return daysRemaining <= 3 ? { state: 'warn', daysRemaining } : { state: 'valid', daysRemaining };
}

/**
 * What a revoked device is told at sync time.
 *
 * `wipe_local` is an *instruction*, honoured by a device that is online enough
 * to receive it. It is not a guarantee and the contract does not present it as
 * one.
 */
export interface RevocationNotice {
  device_id: string;
  revoked: true;
  revoked_reason: string | null;
  wipe_local: boolean;
}
