/**
 * F0.4 — the wire surface, in one place.
 *
 * **This is the seam the three lanes meet at.** Lane A serves these shapes,
 * Lane B and Lane C consume them against fixtures. Changes here are announced
 * in `integration/requests-<lane>.md`, never made silently: a contract edit is
 * the only change that can break all three lanes at once, and `npm run
 * typecheck` is what catches it.
 */

export * from './common.js';
export * from './bundle.js';
export * from './sync.js';
export * from './media.js';
export * from './entities.js';
export * from './defects.js';
export * from './ingest.js';
