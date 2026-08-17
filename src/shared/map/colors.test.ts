/**
 * B3 — status -> colour resolution. The caller owns the status vocabulary
 * (sampler `pending`/`sampled`/`skipped`, ingest `RowStatus`); these
 * functions must not assume either one.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_STATUS_COLOR, resolveStatusColor, statusColorExpression } from './colors.js';

describe('resolveStatusColor', () => {
  it('looks up a known status', () => {
    expect(resolveStatusColor('sampled', { sampled: '#00ff00', pending: '#888888' })).toBe('#00ff00');
  });

  it('falls back to the default grey for an unrecognised status', () => {
    expect(resolveStatusColor('unknown-status', { sampled: '#00ff00' })).toBe(DEFAULT_STATUS_COLOR);
  });

  it('honours a caller-supplied fallback over the module default', () => {
    expect(resolveStatusColor('unknown-status', {}, '#ff00ff')).toBe('#ff00ff');
  });

  it('sampler and ingest vocabularies both resolve through the same function', () => {
    const samplerColors = { pending: '#9ca3af', sampled: '#16a34a', skipped: '#f59e0b' };
    const ingestColors = { ready: '#16a34a', flagged: '#f59e0b', blocked: '#dc2626' };
    expect(resolveStatusColor('sampled', samplerColors)).toBe('#16a34a');
    expect(resolveStatusColor('blocked', ingestColors)).toBe('#dc2626');
  });
});

describe('statusColorExpression', () => {
  it('builds a match expression covering every entry plus a trailing fallback', () => {
    const expr = statusColorExpression({ ready: '#16a34a', blocked: '#dc2626' });
    expect(expr).toEqual(['match', ['get', 'status'], 'ready', '#16a34a', 'blocked', '#dc2626', DEFAULT_STATUS_COLOR]);
  });

  it('uses a caller-supplied fallback as the final element', () => {
    const expr = statusColorExpression({ pending: '#9ca3af' }, '#111111');
    expect(expr[expr.length - 1]).toBe('#111111');
  });

  it('an empty status map still produces a valid match expression with just the fallback', () => {
    expect(statusColorExpression({})).toEqual(['match', ['get', 'status'], DEFAULT_STATUS_COLOR]);
  });
});
