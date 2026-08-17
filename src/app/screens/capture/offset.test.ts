import { describe, expect, it } from 'vitest';
import { classifyOffset } from './offset.js';

describe('classifyOffset', () => {
  it('is ok at and under the warn threshold', () => {
    expect(classifyOffset(0, 15, 30)).toBe('ok');
    expect(classifyOffset(15, 15, 30)).toBe('ok');
  });

  it('warns strictly beyond warn, at or under block', () => {
    expect(classifyOffset(15.01, 15, 30)).toBe('warn');
    expect(classifyOffset(30, 15, 30)).toBe('warn');
  });

  it('blocks strictly beyond the block threshold', () => {
    expect(classifyOffset(30.01, 15, 30)).toBe('block');
    expect(classifyOffset(1000, 15, 30)).toBe('block');
  });
});
