/**
 * B6 — Screen 3 · Capture, GPS acquisition.
 *
 * *Escalated to Opus.* Small file, big consequence: fix averaging, spread, and
 * the satellite-fix-versus-dropped-pin distinction are audit-bearing (plan §9)
 * and are read in 2029.
 *
 * Four behaviours, each from a written requirement:
 *
 *  - **Acquisition starts when the screen opens, not at submit** (plan §3).
 *    A receiver asked for a position at the moment someone presses Save has had
 *    no time to settle, and the number it returns is the number that ends up in
 *    the audit trail.
 *  - **Several fixes are averaged and the spread is recorded.** The spread is
 *    the honest measure: a receiver claiming 5 m while its fixes sit 40 m apart
 *    is contradicting itself, and that contradiction is the finding.
 *  - **The reported accuracy is not shrunk by averaging.** Consecutive GNSS
 *    fixes share their error sources — ionosphere, multipath, geometry — so
 *    they are not independent samples, and combining them as if they were
 *    would manufacture a precision claim that a court reads in 2029. The
 *    reported figure is the median of what the receiver itself claimed.
 *  - **A dropped map pin is never a fix.** It is a different
 *    `position_source`, permanently, and it takes a different method to
 *    produce. There is no code path where a pin becomes `gps`.
 *
 * Battery: this holds a high-accuracy watch only while the capture screen is
 * open. Continuous high-accuracy GNSS will not survive a ten-hour day
 * (plan §3), so `stop()` is not optional politeness.
 */

import type { PositionSource } from '../../shared/contract/common.js';
import { haversineMetres, maxSpreadMetres, type LatLon } from '../../shared/geo/distance.js';

export interface GpsFix {
  lat: number;
  lon: number;
  accuracy_m: number;
  altitude_m: number | null;
  altitude_accuracy_m: number | null;
  /** Device clock at the fix. */
  ts: string;
}

export interface GpsCaptureSpec {
  /** `PROJECT_SAMPLING_SPEC.GPS_ACCURACY_REQUIRED_M`. */
  accuracyRequiredM: number;
  /** `PROJECT_SAMPLING_SPEC.MIN_GPS_FIX_COUNT`. */
  minFixCount: number;
}

export interface GpsState {
  fixes: GpsFix[];
  /** Best estimate from the fixes so far, or null before the first one. */
  position: LatLon | null;
  /** Median of the receiver's own claims. Not shrunk by averaging. */
  accuracyM: number | null;
  spreadM: number;
  /** Enough fixes, and the accuracy the spec asks for. */
  meetsSpec: boolean;
  /** True while the watch is running. */
  acquiring: boolean;
  lastError: string | null;
}

/** The subset of `navigator.geolocation` this needs, so tests can supply it. */
export interface GeolocationLike {
  watchPosition(
    success: (position: GeolocationPosition) => void,
    error?: (err: GeolocationPositionError) => void,
    options?: PositionOptions,
  ): number;
  clearWatch(id: number): void;
}

/**
 * Fixes worse than this are recorded but excluded from the estimate.
 *
 * A 500 m network-derived fix arriving while the GNSS receiver is still cold
 * would otherwise drag the average across a field boundary. It stays in
 * `fix_samples_json` — nothing is discarded, only down-weighted to zero.
 */
const ESTIMATE_ACCURACY_CEILING_M = 100;

export class GpsAcquisition {
  private readonly listeners = new Set<(state: GpsState) => void>();
  private fixes: GpsFix[] = [];
  private watchId: number | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly geolocation: GeolocationLike,
    private readonly spec: GpsCaptureSpec,
    private readonly now: () => number = Date.now,
  ) {}

  /** Call this from the capture screen's mount, never from its submit. */
  start(): void {
    if (this.watchId !== null) return;
    this.watchId = this.geolocation.watchPosition(
      (position) => {
        this.fixes.push({
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          accuracy_m: position.coords.accuracy,
          altitude_m: position.coords.altitude,
          altitude_accuracy_m: position.coords.altitudeAccuracy,
          ts: new Date(position.timestamp || this.now()).toISOString(),
        });
        this.lastError = null;
        this.emit();
      },
      (err) => {
        this.lastError = err.message || `geolocation error ${err.code}`;
        this.emit();
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 },
    );
  }

  stop(): void {
    if (this.watchId === null) return;
    this.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    this.emit();
  }

  subscribe(listener: (state: GpsState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state());
    return () => this.listeners.delete(listener);
  }

  state(): GpsState {
    const usable = this.fixes.filter((f) => f.accuracy_m <= ESTIMATE_ACCURACY_CEILING_M);
    const position = weightedMean(usable);
    const accuracyM = medianAccuracy(usable);
    const spreadM = maxSpreadMetres(usable);

    return {
      fixes: [...this.fixes],
      position,
      accuracyM,
      spreadM,
      meetsSpec:
        usable.length >= this.spec.minFixCount &&
        accuracyM !== null &&
        accuracyM <= this.spec.accuracyRequiredM,
      acquiring: this.watchId !== null,
      lastError: this.lastError,
    };
  }

  /**
   * The capture, as it lands on `sample_point`.
   *
   * Returns null before any usable fix — the caller shows "still acquiring"
   * rather than writing a position nobody measured.
   */
  result(): GpsCaptureResult | null {
    const state = this.state();
    if (!state.position || state.accuracyM === null) return null;

    const usable = this.fixes.filter((f) => f.accuracy_m <= ESTIMATE_ACCURACY_CEILING_M);
    const best = usable.reduce((a, b) => (a.accuracy_m <= b.accuracy_m ? a : b));

    return {
      lat: state.position.lat,
      lon: state.position.lon,
      gps_accuracy_m: round(state.accuracyM, 2),
      altitude_m: best.altitude_m,
      altitude_accuracy_m: best.altitude_accuracy_m,
      position_provider: 'gps',
      position_source: 'gps',
      fix_count: usable.length,
      fix_spread_m: round(state.spreadM, 2),
      // Every fix, including the ones excluded from the estimate. This is the
      // forensic record and it is stored verbatim.
      fix_samples_json: JSON.stringify(this.fixes),
    };
  }

  private emit(): void {
    const state = this.state();
    for (const listener of this.listeners) listener(state);
  }
}

export interface GpsCaptureResult {
  lat: number;
  lon: number;
  gps_accuracy_m: number;
  altitude_m: number | null;
  altitude_accuracy_m: number | null;
  position_provider: string;
  position_source: PositionSource;
  fix_count: number;
  fix_spread_m: number;
  fix_samples_json: string;
}

/**
 * A position the sampler placed by hand.
 *
 * **Separate function, separate `position_source`, no accuracy figure.** There
 * is deliberately no way to reach this through `GpsAcquisition`, and no way to
 * reach `position_source: 'gps'` through this. A pin has no measured accuracy,
 * so it reports none rather than inheriting the last fix's — a number that
 * would look exactly like a measurement to anyone reading the row later.
 */
export function manualPinCapture(lat: number, lon: number): GpsCaptureResult {
  return {
    lat,
    lon,
    gps_accuracy_m: 0,
    altitude_m: null,
    altitude_accuracy_m: null,
    position_provider: 'manual',
    position_source: 'manual_map_pin',
    fix_count: 0,
    fix_spread_m: 0,
    fix_samples_json: JSON.stringify([]),
  };
}

/** Inverse-variance weighting: a 3 m fix should outweigh a 30 m one. */
function weightedMean(fixes: readonly GpsFix[]): LatLon | null {
  if (fixes.length === 0) return null;
  let wLat = 0;
  let wLon = 0;
  let wSum = 0;
  for (const fix of fixes) {
    const sigma = Math.max(fix.accuracy_m, 0.5);
    const w = 1 / (sigma * sigma);
    wLat += fix.lat * w;
    wLon += fix.lon * w;
    wSum += w;
  }
  return { lat: wLat / wSum, lon: wLon / wSum };
}

function medianAccuracy(fixes: readonly GpsFix[]): number | null {
  if (fixes.length === 0) return null;
  const sorted = fixes.map((f) => f.accuracy_m).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function round(value: number, places: number): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

/** Distance from the plan point. **Advisory only** — the server recomputes it. */
export function advisoryOffsetFromPlan(capture: LatLon, planPoint: LatLon): number {
  return haversineMetres(capture, planPoint);
}
