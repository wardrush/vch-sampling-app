/**
 * Real-browser smoke test for the sampler flow. `playwright.config.ts`'s own
 * header explains why this has to exist: `npm test` cannot open the device
 * database at all (no IndexedDB, no wasm host that behaves like a browser's
 * in Node/jsdom), so the driver shipped once having never actually run and
 * failed on the first real device. This file drives the real thing, in a
 * real Chromium, against the real production bundle.
 *
 * **The one assertion that would have caught the shipped bug**: the "Device
 * database unavailable" banner must never appear. Every screen renders it
 * verbatim (`Badge label={`Device database unavailable: ${...}`}`) the
 * moment `useDeviceDb()` reports `status: 'error'` — see `TodayScreen.tsx`,
 * `CaptureScreen.tsx`, `ScreenPlaceholder.tsx`.
 *
 * **The second assertion the fallback needs**: `MemoryFallbackBanner`'s text
 * ("Not saving to this device …") must *also* never appear here. A real,
 * unsandboxed Chromium has working IndexedDB, so the primary path
 * (`IDBBatchAtomicVFS`) must be the one that answers — if this banner shows
 * up instead, the memory fallback silently took over on a browser that
 * didn't need it, which is exactly the kind of quiet regression the task
 * asked this suite to fail loudly on.
 *
 * Flow driven: cold load → first-run tutorial (skip it) → Today → Field →
 * Capture → save → Field (now 1/6 done) → Today (counts updated) → Outbox
 * (the saved point is pending) → reload the page → Outbox still shows it,
 * which is the actual proof of persistence, not just "the app didn't crash".
 */

import { test, expect, type Page } from '@playwright/test';
import { decodePng, pixelAt, colorDistance } from './support/png.js';

async function assertDatabaseHealthy(page: Page): Promise<void> {
  await expect(page.getByText(/Device database unavailable/i)).toHaveCount(0);
  await expect(page.getByText(/Not saving to this device/i)).toHaveCount(0);
}

test('sampler flow: tutorial skip → Today → Field → Capture → Outbox, database genuinely open', async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    // The browser's own "Failed to load resource: …" line for a network 404
    // carries no URL in `msg.text()` (a Chromium DevTools Protocol quirk —
    // the URL only shows up on the `Response`, tracked separately below).
    // It is never how *this app* reports an error — every explicit
    // `console.error` this codebase writes says what failed and why — so a
    // bare "Failed to load resource" line is resource-fetch noise, not a
    // signal, and is deliberately not collected here.
    if (/^Failed to load resource:/i.test(msg.text())) return;
    consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(err.message));

  // Network-level failures, tracked with their actual URL so only the one
  // known-benign 404 (see below) can be excused — anything else fails loudly.
  const failedResponses: string[] = [];
  page.on('response', (res) => {
    if (res.status() >= 400) failedResponses.push(`${res.status()} ${res.url()}`);
  });

  // ── Cold load — first-run tutorial gate fires ──────────────────────────
  await page.goto('/');
  await expect(page).toHaveURL(/\/tutorial$/);
  await expect(page.getByText('Quick walkthrough')).toBeVisible();
  await assertDatabaseHealthy(page);

  // Skip still sets tutorial_completed_ts (v02 §4.5) — exercise that path
  // rather than walking all four tutorial steps, which is covered by unit
  // tests owning the component logic; this suite's job is the real database.
  await page.getByRole('button', { name: 'Skip' }).click();
  await expect(page).toHaveURL('/');

  // A second cold load must not re-show the tutorial.
  await page.reload();
  await expect(page).toHaveURL('/');
  await assertDatabaseHealthy(page);

  // ── Today — the six fixture plan points' boundary appears ──────────────
  const boundaryCard = page.getByText('Johnson Farm - East 40');
  await expect(boundaryCard).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/0 of 6 points/)).toBeVisible();
  await assertDatabaseHealthy(page);

  // ── Field — all six points, coloured by state ──────────────────────────
  await boundaryCard.click();
  await expect(page).toHaveURL(/\/field\/b-001$/);
  for (const label of ['PT-001', 'PT-002', 'PT-003', 'PT-004', 'PT-005', 'PT-006']) {
    await expect(page.getByRole('button', { name: label })).toBeVisible();
  }
  await assertDatabaseHealthy(page);

  // The map is the visual centrepiece of this demo, and a collapsed
  // container is exactly the failure mode that shipped before: MapLibre
  // initialises, the canvas gets a real width and *zero* height, and the
  // whole boundary/pin picture is silently invisible while every other
  // assertion in this file still passes. `<BoundaryMap>` renders one
  // `role="region"` per Screen 2 — this is the seam this suite can check
  // from outside `src/shared/map/**` without owning any of it.
  const mapRegion = page.getByRole('region', { name: /^Map of/ });
  await expect(mapRegion).toBeVisible();
  // MapLibre's own 'load' event (and the `fitBounds` it triggers) is async;
  // give it a moment to settle before measuring/screenshotting rather than
  // measuring the very first (possibly still-collapsing) layout pass.
  await page.waitForTimeout(500);

  const mapBox = await mapRegion.boundingBox();
  if (!mapBox) throw new Error('map region has no bounding box at all — not just short, absent');
  expect(mapBox.height, 'map container height must not have collapsed to ~0').toBeGreaterThan(300);

  const viewport = page.viewportSize();
  if (viewport) {
    // "Confirm the layout does not leave large dead space": the map should
    // fill most of the screen, not sit as a sliver above a mostly-empty
    // page — the coordinator's own screenshot showed exactly that failure
    // mode (a small `minHeight: 240` floor plus a lot of blank space below
    // the point strip) when the height chain was broken.
    expect(
      mapBox.height / viewport.height,
      `map should fill a large majority of the viewport (got ${mapBox.height}px of ${viewport.height}px)`,
    ).toBeGreaterThan(0.35);
  }

  // And no *gap* dead space either: the point-chip strip should sit
  // directly under the map, not float with empty space between them.
  const firstChipBox = await page.getByRole('button', { name: 'PT-001' }).boundingBox();
  if (!firstChipBox) throw new Error('point chip has no bounding box');
  const gapBelowMap = firstChipBox.y - (mapBox.y + mapBox.height);
  expect(gapBelowMap, 'no dead space between the map and the point-chip strip').toBeLessThan(40);

  // Finally, the part a size/position check cannot prove on its own: pixels
  // were actually painted, not just a correctly-sized empty canvas. Sampled
  // via a real screenshot (the browser's compositor output — what a human
  // looking at the screen sees), not a WebGL buffer readback, which would
  // be a timing race against a context `<BoundaryMap>` does not configure
  // for it (no `preserveDrawingBuffer`) — exactly the flakiness this
  // assertion needs to avoid. `fitBounds` centres the boundary polygon in
  // the viewport, so the centre pixel should sit inside its (translucent,
  // but non-transparent) fill; a corner, inset 5%, sits in the flat
  // no-tile-pack background outside it. Equal colours would mean nothing
  // was drawn on top of that background at all.
  const mapScreenshot = await mapRegion.screenshot();
  const mapImage = decodePng(mapScreenshot);
  const center = pixelAt(mapImage, Math.floor(mapImage.width / 2), Math.floor(mapImage.height / 2));
  const corner = pixelAt(mapImage, Math.floor(mapImage.width * 0.05), Math.floor(mapImage.height * 0.05));
  expect(
    colorDistance(center, corner),
    `map centre ${JSON.stringify(center)} and a corner ${JSON.stringify(corner)} render as the same flat ` +
      `colour — the boundary polygon (and pins) are not actually painted, only a correctly-sized empty canvas is`,
  ).toBeGreaterThan(12);

  // ── Capture — save a point with no camera/GPS granted ───────────────────
  await page.getByRole('button', { name: 'PT-001' }).click();
  await expect(page).toHaveURL(/\/capture\/b-001\/pp-001$/);
  const saveButton = page.getByRole('button', { name: /^Save$/ });
  await expect(saveButton).toBeEnabled({ timeout: 15_000 });
  await assertDatabaseHealthy(page);
  await saveButton.click();

  // Save navigates back to Field on success — this is the assertion that the
  // whole local write (field_visit → sample_point → sample_bag → outbox)
  // actually completed rather than throwing.
  await expect(page).toHaveURL(/\/field\/b-001$/, { timeout: 15_000 });
  await expect(page.getByText(/1 of 6 points done/)).toBeVisible();
  await assertDatabaseHealthy(page);

  // ── Today again — the saved point moved the count ───────────────────────
  await page.getByRole('button', { name: /Today/ }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByText(/1 of 6 points/)).toBeVisible();
  await assertDatabaseHealthy(page);

  // ── Outbox — the record is really there ─────────────────────────────────
  // Exact match: the status strip also has a "Outbox: N pending" link, and a
  // loose match would hit both and fail Playwright's strict-mode uniqueness.
  await page.getByRole('link', { name: 'Outbox', exact: true }).click();
  await expect(page).toHaveURL(/\/outbox$/);
  await expect(page.getByText(/Pending: [1-9]/)).toBeVisible();
  await expect(page.getByText('sample_point').first()).toBeVisible();
  await assertDatabaseHealthy(page);

  // ── Reload — proof this is IndexedDB, not memory that happened to survive
  //    within one page lifetime ─────────────────────────────────────────────
  await page.reload();
  await expect(page).toHaveURL(/\/outbox$/);
  await expect(page.getByText(/Pending: [1-9]/)).toBeVisible({ timeout: 15_000 });
  await assertDatabaseHealthy(page);

  // No screen in this walk logged a console error. A thrown-and-caught
  // "device unavailable" would show up as rendered text (already asserted
  // absent above); this catches anything that slipped past a try/catch.
  const meaningfulErrors = consoleErrors.filter(
    (e) => !/Download the React DevTools/i.test(e) && !/ReactDOMTestUtils\.act/i.test(e),
  );
  expect(meaningfulErrors, `console errors during the flow:\n${meaningfulErrors.join('\n')}`).toEqual([]);

  // Every network response is a 2xx/3xx, with two named exceptions. Nothing
  // else — a broken asset, a function 404ing where a fixture should have
  // answered — is excused.
  const EXPECTED_FAILURES = [
    // Chromium auto-probes this regardless of the `<link rel="icon">`
    // `index.html` actually declares (`/icons/favicon-48.png`, which
    // resolves fine and is not this exception).
    /\/favicon\.ico$/,
    // `markTutorialCompleted()`'s best-effort server-side flag
    // (`@app/shell/tutorial.js`) — no such function exists yet (v02 §4.5's
    // server-side `tutorial_completed_ts` is a named, documented gap, not a
    // silently-swallowed one). Local persistence is the fallback and is
    // what the "second cold load must not re-show the tutorial" assertion
    // above already proves works.
    /\/v1\/device\/tutorial-complete$/,
  ];
  const unexpectedFailures = failedResponses.filter((f) => !EXPECTED_FAILURES.some((re) => re.test(f)));
  expect(unexpectedFailures, `unexpected HTTP failures:\n${unexpectedFailures.join('\n')}`).toEqual([]);
});
