import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueueFullError, TokenBucket } from '../../src/rest/token-bucket.js';

const FREE_PLAN = { capacity: 1, refillPerSecond: 1, maxQueue: 10 };

describe('TokenBucket', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function track(bucket: TokenBucket, count: number): number[] {
    const grantedAt: number[] = [];
    for (let i = 0; i < count; i += 1) void bucket.acquire().then(() => grantedAt.push(Date.now()));
    return grantedAt;
  }

  it('lets exactly one request per second through on the free plan', async () => {
    const start = Date.now();
    const grantedAt = track(new TokenBucket(FREE_PLAN), 3);
    await vi.advanceTimersByTimeAsync(0);
    expect(grantedAt).toEqual([start]);
    await vi.advanceTimersByTimeAsync(999);
    expect(grantedAt).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(grantedAt.map((t) => t - start)).toEqual([0, 1000, 2000]);
  });

  it('does not accumulate a burst while idle when capacity is 1', async () => {
    const bucket = new TokenBucket(FREE_PLAN);
    await vi.advanceTimersByTimeAsync(60_000);
    const grantedAt = track(bucket, 2);
    await vi.advanceTimersByTimeAsync(0);
    expect(grantedAt).toHaveLength(1);
  });

  it('allows a burst up to capacity', async () => {
    const grantedAt = track(new TokenBucket({ capacity: 3, refillPerSecond: 1, maxQueue: 10 }), 4);
    await vi.advanceTimersByTimeAsync(0);
    expect(grantedAt).toHaveLength(3);
  });

  it('a refunded slot goes to the next waiter immediately', async () => {
    const bucket = new TokenBucket(FREE_PLAN);
    await bucket.acquire();
    const grantedAt = track(bucket, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(grantedAt).toHaveLength(0);
    bucket.refund();
    await vi.advanceTimersByTimeAsync(0);
    expect(grantedAt).toHaveLength(1);
  });

  it('rejects when the queue is full instead of growing without bound', async () => {
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1, maxQueue: 2 });
    await bucket.acquire();
    void bucket.acquire();
    void bucket.acquire();
    expect(bucket.queued).toBe(2);
    await expect(bucket.acquire()).rejects.toBeInstanceOf(QueueFullError);
  });

  it.each([
    { capacity: 0, refillPerSecond: 1, maxQueue: 1 },
    { capacity: 1, refillPerSecond: 0, maxQueue: 1 },
    { capacity: 1, refillPerSecond: 1, maxQueue: -1 },
  ])('validates options %o', (options) => {
    expect(() => new TokenBucket(options)).toThrow(RangeError);
  });
});
