import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { unixSeconds } from '../../src/core/time.js';
import { launchesInWindow, newCreator, recordLaunch } from '../../src/state/creator-state.js';
import { createRestClient } from '../../src/state/factory.js';
import { comparePositions, timePosition } from '../../src/state/order.js';
import { QuotePrices } from '../../src/state/quote-prices.js';
import { T0, testConfig } from './helpers.js';

const s = unixSeconds;

describe('creator launches', () => {
  it('keeps the newest maxLaunches; launches with unknown creation time go first', () => {
    const c = newCreator('C', s(T0));
    recordLaunch(c, 'unknown', null, 'stream', 3);
    recordLaunch(c, 'b', s(T0 + 2), 'rest', 3);
    recordLaunch(c, 'a', s(T0 + 2), 'rest', 3);
    recordLaunch(c, 'new', s(T0 + 9), 'stream', 3);
    expect([...c.launches.keys()].sort()).toEqual(['a', 'b', 'new']);
    recordLaunch(c, 'newer', s(T0 + 10), 'stream', 3);
    expect([...c.launches.keys()].sort()).toEqual(['b', 'new', 'newer']); // tie at T0+2: 'a' < 'b' goes
  });

  it('a stream sighting upgrades a launch learned from REST, and the earliest time wins', () => {
    const c = newCreator('C', s(T0));
    recordLaunch(c, 'm', s(T0 + 5), 'rest', 10);
    recordLaunch(c, 'm', s(T0 + 3), 'stream', 10);
    expect(c.launches.get('m')).toMatchObject({ source: 'stream', createdAt: T0 + 3 });
    expect(c.firstSeen).toBe(T0);
    expect(launchesInWindow(c, s(T0 + 100), 50)).toBe(0);
    expect(launchesInWindow(c, s(T0 + 100), 200)).toBe(1);
  });
});

describe('QuotePrices', () => {
  it('learns USD per unit, ignores zero amounts/zero USD and older positions', () => {
    const q = new QuotePrices();
    expect(q.observe('SOL', 0n, 9, new Decimal(5), timePosition(s(T0)))).toBeNull();
    expect(q.observe('SOL', 2_000_000_000n, 9, new Decimal(0), timePosition(s(T0)))).toBeNull();
    expect(q.observe('SOL', 2_000_000_000n, 9, new Decimal(240), timePosition(s(T0 + 10)))?.toNumber()).toBe(120);
    q.observe('SOL', 1_000_000_000n, 9, new Decimal(999), timePosition(s(T0))); // older: not kept
    expect(q.get('SOL')?.usdPerUnit.toNumber()).toBe(120);
  });

  it('is bounded; a frequently updated quote (SOL) is never the one evicted', () => {
    const q = new QuotePrices(2);
    q.observe('SOL', 1n, 0, new Decimal(1), timePosition(s(T0)));
    q.observe('X', 1n, 0, new Decimal(1), timePosition(s(T0 + 1)));
    q.observe('SOL', 1n, 0, new Decimal(1), timePosition(s(T0 + 2)));
    q.observe('Y', 1n, 0, new Decimal(1), timePosition(s(T0 + 3)));
    expect(q.size).toBe(2);
    expect(q.get('SOL')).toBeDefined();
    expect(q.get('X')).toBeUndefined();
  });

  it('positions compare lexicographically', () => {
    expect(comparePositions([1, 2, 3, 4, 5], [1, 2, 3, 4, 6])).toBeLessThan(0);
    expect(comparePositions([2, 0, 0, 0, 0], [1, 9, 9, 9, 9])).toBeGreaterThan(0);
    expect(comparePositions([1, 1, 1, 1, 1], [1, 1, 1, 1, 1])).toBe(0);
  });
});

describe('createRestClient', () => {
  it('needs the API key', () => {
    expect(() => createRestClient(testConfig())).toThrow('SOLAMI_API_KEY');
    expect(createRestClient({ ...testConfig(), apiKey: 'k' })).toBeDefined();
  });
});
