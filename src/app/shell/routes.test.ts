import { describe, expect, it } from 'vitest';
import {
  ROUTE_PATHS,
  NAV_DESTINATIONS,
  fieldPath,
  capturePath,
  captureNewPath,
  skipPath,
} from './routes.js';

describe('route path builders', () => {
  it('produce paths matching their react-router pattern shape', () => {
    expect(fieldPath('b1')).toBe('/field/b1');
    expect(capturePath('b1', 'p1')).toBe('/capture/b1/p1');
    expect(captureNewPath('b1')).toBe('/capture/b1/new');
    expect(skipPath('b1', 'p1')).toBe('/skip/b1/p1');
  });

  it('every builder output matches its ROUTE_PATHS pattern with params substituted', () => {
    const cases: Array<[string, string]> = [
      [fieldPath('b1'), ROUTE_PATHS.field],
      [capturePath('b1', 'p1'), ROUTE_PATHS.capture],
      [skipPath('b1', 'p1'), ROUTE_PATHS.skip],
    ];
    for (const [built, pattern] of cases) {
      const regex = new RegExp('^' + pattern.replace(/:[^/]+/g, '[^/]+') + '$');
      expect(built).toMatch(regex);
    }
  });
});

describe('NAV_DESTINATIONS', () => {
  it('is exactly the three persistent tabs, each a real ROUTE_PATHS entry', () => {
    expect(NAV_DESTINATIONS.map((d) => d.key)).toEqual(['today', 'outbox', 'storage']);
    for (const dest of NAV_DESTINATIONS) {
      expect(dest.path).toBe(ROUTE_PATHS[dest.key]);
    }
  });
});
