import { describe, expect, it } from 'vitest';
import { _resetDeviceIdForTests, getOrCreateDeviceId, type KeyValueStorage } from './device-id.js';

function fakeStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

describe('getOrCreateDeviceId', () => {
  it('creates a UUIDv7-shaped id and persists it to the given storage', () => {
    _resetDeviceIdForTests();
    const storage = fakeStorage();
    const id = getOrCreateDeviceId(storage);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(storage.getItem('vch_sampler_device_id')).toBe(id);
  });

  it('reuses the id already in storage rather than minting a new one', () => {
    _resetDeviceIdForTests();
    const storage = fakeStorage();
    storage.setItem('vch_sampler_device_id', 'existing-id');
    expect(getOrCreateDeviceId(storage)).toBe('existing-id');
  });

  it('memoises across calls within the same session even with a fresh storage handle', () => {
    _resetDeviceIdForTests();
    const first = getOrCreateDeviceId(fakeStorage());
    const second = getOrCreateDeviceId(fakeStorage());
    expect(second).toBe(first);
  });
});
