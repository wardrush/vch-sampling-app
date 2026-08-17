/**
 * B3 — the offline MapLibre style. Structural offline-first check: no
 * network style URL, `glyphs`, or `sprite` ever appears in the built
 * style, whether or not a tile pack was supplied.
 */

import { describe, expect, it } from 'vitest';
import { buildStyle, NO_PACK_BACKGROUND_COLOR, pmtilesUrl, ROUTE_PACK_LAYER_ID, ROUTE_PACK_SOURCE_ID } from './style.js';

describe('buildStyle', () => {
  it('with no tile pack: background only, no sources', () => {
    const style = buildStyle(null);
    expect(Object.keys(style.sources)).toEqual([]);
    expect(style.layers).toHaveLength(1);
    expect(style.layers[0]?.type).toBe('background');
  });

  it('with a tile pack: adds exactly one raster pmtiles source and layer', () => {
    const style = buildStyle('opfs://packs/route-42.pmtiles');
    expect(Object.keys(style.sources)).toEqual([ROUTE_PACK_SOURCE_ID]);
    const source = style.sources[ROUTE_PACK_SOURCE_ID];
    expect(source?.type).toBe('raster');
    expect((source as { url: string }).url).toBe('pmtiles://opfs://packs/route-42.pmtiles');
    expect(style.layers.map((l) => l.id)).toContain(ROUTE_PACK_LAYER_ID);
  });

  it('never references a network style, glyphs, or sprite -- offline-first is structural', () => {
    const withPack = buildStyle('opfs://packs/route-42.pmtiles');
    const withoutPack = buildStyle(null);
    for (const style of [withPack, withoutPack]) {
      expect(style).not.toHaveProperty('glyphs');
      expect(style).not.toHaveProperty('sprite');
      const json = JSON.stringify(style);
      expect(json).not.toMatch(/https?:\/\//);
    }
  });

  it('the no-pack background is a flat colour, never a fallback source', () => {
    const style = buildStyle(null);
    const bg = style.layers.find((l) => l.type === 'background');
    expect(bg?.paint).toEqual({ 'background-color': NO_PACK_BACKGROUND_COLOR });
  });
});

describe('pmtilesUrl', () => {
  it('prefixes a bare local resource URL', () => {
    expect(pmtilesUrl('opfs://packs/a.pmtiles')).toBe('pmtiles://opfs://packs/a.pmtiles');
  });

  it('is idempotent on an already-prefixed URL', () => {
    expect(pmtilesUrl('pmtiles://opfs://packs/a.pmtiles')).toBe('pmtiles://opfs://packs/a.pmtiles');
  });
});
