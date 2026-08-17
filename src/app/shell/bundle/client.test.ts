import { describe, expect, it } from 'vitest';
import { demoBundleFromFixture, fetchAssignmentBundle } from './client.js';

describe('demoBundleFromFixture', () => {
  it('reshapes the F0.7 fixture to the wire AssignmentBundle contract', () => {
    const bundle = demoBundleFromFixture();

    expect(bundle.boundaries).toHaveLength(1);
    expect(bundle.plan_points).toHaveLength(6);
    expect(bundle.specs).toHaveLength(1);
    expect(bundle.tile_pack?.version).toBe('f26-nd-w-01');

    // `boundary_name` in the fixture becomes `property_name` on the wire —
    // same reshape `netlify/functions/assignments-bundle.ts`'s own
    // mockBundle() does, independently reproduced here (see client.ts header).
    const boundary = bundle.boundaries[0]!;
    expect(boundary.property_name).toBe('Johnson Farm - East 40');
    expect(boundary.boundary_id).toBe('b-001');
    expect(boundary.geojson.type).toBe('Polygon');
  });

  it('stamps a fresh server_time on every call (the clock-drift baseline, not stable content)', async () => {
    const a = demoBundleFromFixture();
    await new Promise((r) => setTimeout(r, 2));
    const b = demoBundleFromFixture();
    expect(Date.parse(b.server_time)).toBeGreaterThanOrEqual(Date.parse(a.server_time));
  });
});

describe('fetchAssignmentBundle', () => {
  it('falls back to the local fixture when fetch is unavailable (the npm-run-dev path)', async () => {
    const originalFetch = globalThis.fetch;
    // @ts-expect-error -- deliberately removing fetch to exercise the fallback
    delete globalThis.fetch;
    try {
      const result = await fetchAssignmentBundle();
      expect(result.source).toBe('local_fixture');
      expect(result.bundle.boundaries).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('falls back to the local fixture on a non-2xx response', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;
    try {
      const result = await fetchAssignmentBundle();
      expect(result.source).toBe('local_fixture');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('falls back to the local fixture when plain `vite dev` answers 200 with its SPA-fallback index.html instead of JSON', async () => {
    // Verified against a real `npm run dev` run (no functions runtime): the
    // route resolves through Vite's history-fallback and returns 200
    // text/html, not a 404. `res.json()` on that body throws, which this
    // function's own try/catch turns into the same fallback as any other
    // failure — this test locks that real, observed behaviour in rather than
    // an assumed 404.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch;
    try {
      const result = await fetchAssignmentBundle();
      expect(result.source).toBe('local_fixture');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses the network response when it answers 2xx', async () => {
    const originalFetch = globalThis.fetch;
    const fake = demoBundleFromFixture();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(fake), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    try {
      const result = await fetchAssignmentBundle();
      expect(result.source).toBe('network');
      expect(result.bundle.bundle_id).toBe(fake.bundle_id);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
