/**
 * A simulated receiver, so the tutorial can show acquisition rather than
 * describe it.
 *
 * It implements `GeolocationLike` and is fed to the ordinary `GpsAcquisition`,
 * unmodified. That is the point: the tutorial exercises the real averaging, the
 * real inverse-variance weighting, the real median-of-claimed-accuracy rule and
 * the real spread calculation. What the sampler watches on the accuracy chip is
 * the code that will run in the field, not a mock of it.
 *
 * The fixes arrive on a timer rather than all at once, because "GPS acquires on
 * screen open, not on submit" is the behaviour being taught and it is invisible
 * if the answer is already there on the first frame.
 *
 * What comes *out* of the tutorial session is nevertheless never
 * `position_source: 'gps'` — see `session.ts` in this directory. A simulated
 * receiver produces `tutorial_simulated_gps`, which is not a `PositionSource`
 * and so cannot be written to `sample_point`.
 */

import type { GeolocationLike } from '../gps.js';
import { TUTORIAL_GPS_TRACK } from './model-data.js';

export interface ScriptedGpsOptions {
  track?: typeof TUTORIAL_GPS_TRACK;
  /** Injected so tests do not wait on wall-clock time. */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  now?: () => number;
}

export function scriptedTutorialGeolocation(options: ScriptedGpsOptions = {}): GeolocationLike {
  const track = options.track ?? TUTORIAL_GPS_TRACK;
  const schedule =
    options.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms) as unknown);
  const cancel = options.cancel ?? ((handle: unknown) => clearTimeout(handle as never));
  const now = options.now ?? Date.now;

  const timers = new Map<number, unknown[]>();
  let nextWatchId = 1;

  return {
    watchPosition(success): number {
      const watchId = nextWatchId++;
      const handles = track.map((fix) =>
        schedule(() => {
          success({
            coords: {
              latitude: fix.lat,
              longitude: fix.lon,
              accuracy: fix.accuracy_m,
              altitude: fix.altitude_m,
              altitudeAccuracy: fix.altitude_accuracy_m,
              heading: null,
              speed: null,
            },
            timestamp: now(),
          } as GeolocationPosition);
        }, fix.after_ms),
      );
      timers.set(watchId, handles);
      return watchId;
    },
    clearWatch(watchId: number): void {
      for (const handle of timers.get(watchId) ?? []) cancel(handle);
      timers.delete(watchId);
    },
  };
}
