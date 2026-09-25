import { describe, expect, it } from 'vitest';
import { Decimal } from '../../src/core/schema.js';
import { unixMillis } from '../../src/core/time.js';
import { LiquidityHistory } from '../../src/rest/liquidity-history.js';
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

describe('LiquidityHistory', () => {
  const reading = (ms: number, usd: string) => ({
    observedAt: unixMillis(ms),
    liquidityUsd: new Decimal(usd),
    holders: 700,
  });

  it('keeps readings in order, bounded per mint', () => {
    const history = new LiquidityHistory({ maxMints: 10, maxReadingsPerMint: 2 });
    history.record('M', reading(1_790_000_000_000, '250000'));
    history.record('M', reading(1_790_000_060_000, '1297.98'));
    history.record('M', reading(1_790_000_120_000, '2.96'));
    expect(history.readings('M').map((r) => r.liquidityUsd.toString())).toEqual(['1297.98', '2.96']);
    expect(history.readings('unknown')).toEqual([]);
  });

  it('bounds the number of mints', () => {
    const history = new LiquidityHistory({ maxMints: 1, maxReadingsPerMint: 5 });
    history.record('A', reading(1_790_000_000_000, '1'));
    history.record('B', reading(1_790_000_000_000, '1'));
    expect(history.readings('A')).toEqual([]);
  });

  it('validates options', () => {
    expect(() => new LiquidityHistory({ maxMints: 1, maxReadingsPerMint: 0 })).toThrow(RangeError);
  });
});
