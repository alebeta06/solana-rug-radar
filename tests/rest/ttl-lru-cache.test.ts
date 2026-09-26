import { describe, expect, it } from 'vitest';
import { unixMillis } from '../../src/core/time.js';
import { TtlLruCache } from '../../src/rest/ttl-lru-cache.js';

function manualClock(start = 1_790_000_000_000) {
  let now = start;
  return { clock: () => unixMillis(now), advance: (ms: number) => (now += ms) };
}

describe('TtlLruCache', () => {
  it('expires entries after the TTL', () => {
    const { clock, advance } = manualClock();
    const cache = new TtlLruCache<string, number>({ maxEntries: 10, ttlMs: 1000 }, clock);
    cache.set('a', 1);
    advance(999);
    expect(cache.get('a')).toBe(1);
    advance(1);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('never expires with ttl Infinity', () => {
    const { clock, advance } = manualClock();
    const cache = new TtlLruCache<string, number>({ maxEntries: 10, ttlMs: Infinity }, clock);
    cache.set('a', 1);
    advance(10 * 365 * 86_400_000);
    expect(cache.get('a')).toBe(1);
  });

  it('evicts the least recently used entry beyond maxEntries', () => {
    const cache = new TtlLruCache<string, number>({ maxEntries: 2, ttlMs: Infinity });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a'); // 'a' is now the most recent
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.size).toBe(2);
  });

  it('validates options', () => {
    expect(() => new TtlLruCache({ maxEntries: 0, ttlMs: 1 })).toThrow(RangeError);
    expect(() => new TtlLruCache({ maxEntries: 1, ttlMs: 0 })).toThrow(RangeError);
  });
});
