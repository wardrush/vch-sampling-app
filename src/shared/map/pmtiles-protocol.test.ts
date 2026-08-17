/**
 * B3 — idempotent `pmtiles://` registration. Guards the exact failure this
 * module exists to prevent: two mounted `<BoundaryMap>`s racing to
 * register the protocol, or allocating a second PMTiles chunk cache.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { _resetPmtilesProtocolForTests, registerPmtilesProtocol } from './pmtiles-protocol.js';
import type { MapLibreProtocolHost } from './pmtiles-protocol.js';

function fakeHost(): MapLibreProtocolHost & { calls: Array<{ name: string; handler: unknown }> } {
  const calls: Array<{ name: string; handler: unknown }> = [];
  return {
    calls,
    addProtocol(name, handler) {
      calls.push({ name, handler });
    },
  };
}

describe('registerPmtilesProtocol', () => {
  beforeEach(() => {
    _resetPmtilesProtocolForTests();
  });

  it('registers the pmtiles:// name', () => {
    const host = fakeHost();
    registerPmtilesProtocol(host);
    expect(host.calls).toHaveLength(1);
    expect(host.calls[0]?.name).toBe('pmtiles');
  });

  it('reuses the same Protocol instance across repeated registrations (one mounted map after another)', () => {
    const host = fakeHost();
    const first = registerPmtilesProtocol(host);
    const second = registerPmtilesProtocol(host);
    expect(second).toBe(first);
  });

  it('re-registers the handler on every call so a map mounted after an earlier one unmounted still finds it', () => {
    const hostA = fakeHost();
    const hostB = fakeHost();
    registerPmtilesProtocol(hostA);
    registerPmtilesProtocol(hostB);
    expect(hostA.calls).toHaveLength(1);
    expect(hostB.calls).toHaveLength(1);
    expect(hostA.calls[0]?.handler).toBe(hostB.calls[0]?.handler);
  });

  it('a fresh module state (simulated by the test reset) allocates a new Protocol', () => {
    const host = fakeHost();
    const first = registerPmtilesProtocol(host);
    _resetPmtilesProtocolForTests();
    const second = registerPmtilesProtocol(host);
    expect(second).not.toBe(first);
  });
});
