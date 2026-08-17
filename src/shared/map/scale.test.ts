/**
 * B3 — pure metres-per-pixel math for the device-position accuracy ring.
 * The one hard cross-check comes straight from the plan doc rather than
 * being re-derived: SAMPLING_APP_PLAN_v02.md §4.4, "at 47° N, z17 gives
 * 0.815 m/px."
 */

import { describe, expect, it } from 'vitest';
import { metersPerPixel, metersToPixels } from './scale.js';

describe('metersPerPixel', () => {
  it('matches v02 §4.4: at 47° N, z17 gives 0.815 m/px', () => {
    expect(metersPerPixel(47, 17)).toBeCloseTo(0.815, 3);
  });

  it('halves for every zoom level up (doubling resolution)', () => {
    const z17 = metersPerPixel(47, 17);
    const z18 = metersPerPixel(47, 18);
    expect(z18).toBeCloseTo(z17 / 2, 6);
  });

  it('is larger away from the equator scaled by cos(lat) (Web Mercator)', () => {
    const atEquator = metersPerPixel(0, 10);
    const at60 = metersPerPixel(60, 10);
    expect(at60).toBeCloseTo(atEquator * Math.cos((60 * Math.PI) / 180), 6);
  });

  it('clamps latitude to the Web Mercator limit rather than going non-finite', () => {
    const atLimit = metersPerPixel(85.05112878, 5);
    const beyond = metersPerPixel(89.9, 5);
    expect(beyond).toBe(atLimit);
    expect(Number.isFinite(beyond)).toBe(true);
  });
});

describe('metersToPixels', () => {
  it('is the inverse of metersPerPixel at the same lat/zoom', () => {
    const mpp = metersPerPixel(47, 17);
    expect(metersToPixels(mpp * 10, 47, 17)).toBeCloseTo(10, 6);
  });

  it('a GPS accuracy ring of a few metres is a handful of pixels at z17', () => {
    // 5 m accuracy at 47 N, z17 -- sanity check on the order of magnitude
    // the Field screen will actually render, not a promised constant.
    const px = metersToPixels(5, 47, 17);
    expect(px).toBeGreaterThan(4);
    expect(px).toBeLessThan(10);
  });

  it('zero real-world distance is zero pixels', () => {
    expect(metersToPixels(0, 47, 17)).toBe(0);
  });
});
