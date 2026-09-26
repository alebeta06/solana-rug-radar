import { describe, expect, it } from 'vitest';
import { EnrichmentScheduler } from '../../src/state/scheduler.js';

const make = (overrides: Partial<ConstructorParameters<typeof EnrichmentScheduler>[0]> = {}) =>
  new EnrichmentScheduler({ maxPending: 100, maxWaitSeconds: 1800, requestsPerSecond: 1, burst: 1, ...overrides });

/** Drains everything the budget allows between `from` and `to`, one tick per second. */
function drain(s: EnrichmentScheduler, from: number, to: number): string[] {
  const out: string[] = [];
  for (let t = from; t <= to; t += 1) {
    const r = s.take(t);
    if (r !== null) out.push(`${r.priority}:${r.creator}`);
  }
  return out;
}

describe('EnrichmentScheduler', () => {
  it('serves suspects, then graduations, then new creators, then known ones; FIFO inside a class', () => {
    const s = make();
    s.enqueue('k1', 'm', 'known-creator', 0);
    s.enqueue('n1', 'm', 'new-creator', 0);
    s.enqueue('g1', 'm', 'graduation', 0);
    s.enqueue('n2', 'm', 'new-creator', 0);
    s.enqueue('s1', 'm', 'suspect', 0);
    expect(drain(s, 0, 10)).toEqual(['suspect:s1', 'graduation:g1', 'new-creator:n1', 'new-creator:n2', 'known-creator:k1']);
  });

  it('spends at most requestsPerSecond (1 req/s: 5 requests need 5 seconds)', () => {
    const s = make();
    for (let i = 0; i < 5; i += 1) s.enqueue(`c${i}`, 'm', 'new-creator', 0);
    expect(drain(s, 0, 2)).toHaveLength(3);
    expect(s.take(2.5)).toBeNull();
    expect(drain(s, 3, 3)).toHaveLength(1);
  });

  it('one request per creator: a duplicate is ignored, a higher priority upgrades it', () => {
    const s = make();
    s.enqueue('c', 'm1', 'new-creator', 0);
    s.enqueue('c', 'm2', 'known-creator', 5);
    expect(s.pending).toBe(1);
    s.enqueue('c', 'm3', 'suspect', 7);
    expect(s.priorityOf('c')).toBe('suspect');
    expect(s.take(10)).toEqual({ creator: 'c', mint: 'm3', priority: 'suspect', enqueuedAt: 0 });
  });

  it('when full, discards the oldest request of the lowest class (counted)', () => {
    const s = make({ maxPending: 2 });
    s.enqueue('g', 'm', 'graduation', 0);
    s.enqueue('k1', 'm', 'known-creator', 1);
    s.enqueue('k2', 'm', 'known-creator', 2);
    s.enqueue('s', 'm', 'suspect', 3);
    expect(s.stats().discardedFull).toMatchObject({ 'known-creator': 2, graduation: 0 });
    expect(drain(s, 10, 20)).toEqual(['suspect:s', 'graduation:g']);
  });

  it('discards a request that waited too long, without spending budget on it', () => {
    const s = make({ maxWaitSeconds: 60 });
    s.enqueue('old', 'm', 'new-creator', 0);
    s.enqueue('new', 'm', 'new-creator', 50);
    expect(s.take(100)?.creator).toBe('new');
    expect(s.stats()).toMatchObject({ discardedStale: { 'new-creator': 1 }, dispatched: { 'new-creator': 1 }, meanWaitSeconds: { 'new-creator': 50 } });
    expect(s.stats().meanWaitSeconds.suspect).toBeNull();
  });

  it('ignores time going backwards (never grants extra budget)', () => {
    const s = make();
    s.enqueue('a', 'm', 'suspect', 0);
    s.enqueue('b', 'm', 'suspect', 0);
    expect(s.take(100)).not.toBeNull();
    expect(s.take(50)).toBeNull();
    expect(s.take(51)).toBeNull(); // would be granted if the clock had been reset to 50
    expect(s.take(101)?.creator).toBe('b');
  });
});
