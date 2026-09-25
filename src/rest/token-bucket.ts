/**
 * Token-bucket rate limiter with a bounded FIFO queue.
 *
 * Free plan: 1 request/second. With `capacity = 1` there is no burst at all: requests leave
 * exactly one per second. `acquire()` resolves when the caller may send its request; callers
 * that end up not needing the slot (e.g. the answer arrived in cache while queued) give it
 * back with `refund()`, so the next request in line goes immediately.
 */
import { millisValue, systemClock, type Clock } from '../core/time.js';

export class QueueFullError extends Error {
  constructor(maxQueue: number) {
    super(`rate-limit queue is full (${maxQueue} waiting)`);
    this.name = 'QueueFullError';
  }
}

export interface TokenBucketOptions {
  /** Max tokens stored = max burst size. */
  readonly capacity: number;
  readonly refillPerSecond: number;
  /** Waiting requests beyond this are rejected instead of growing memory without limit. */
  readonly maxQueue: number;
}

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly waiters: (() => void)[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly options: TokenBucketOptions,
    private readonly clock: Clock = systemClock,
  ) {
    if (options.capacity < 1 || options.refillPerSecond <= 0 || options.maxQueue < 0) {
      throw new RangeError('TokenBucket needs capacity >= 1, refillPerSecond > 0, maxQueue >= 0');
    }
    this.tokens = options.capacity;
    this.lastRefill = millisValue(clock());
  }

  get queued(): number {
    return this.waiters.length;
  }

  acquire(): Promise<void> {
    if (this.waiters.length >= this.options.maxQueue && !this.canServeNow()) {
      return Promise.reject(new QueueFullError(this.options.maxQueue));
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.drain();
    });
  }

  /** Return an unused token obtained from `acquire()`. */
  refund(): void {
    this.refill();
    this.tokens = Math.min(this.options.capacity, this.tokens + 1);
    this.drain();
  }

  private canServeNow(): boolean {
    this.refill();
    return this.waiters.length === 0 && this.tokens >= 1;
  }

  private refill(): void {
    const now = millisValue(this.clock());
    const earned = ((now - this.lastRefill) / 1000) * this.options.refillPerSecond;
    this.tokens = Math.min(this.options.capacity, this.tokens + earned);
    this.lastRefill = now;
  }

  private drain(): void {
    this.refill();
    while (this.waiters.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      this.waiters.shift()?.();
    }
    if (this.waiters.length > 0 && this.timer === undefined) {
      const waitMs = Math.ceil(((1 - this.tokens) / this.options.refillPerSecond) * 1000);
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.drain();
      }, waitMs);
    }
  }
}
