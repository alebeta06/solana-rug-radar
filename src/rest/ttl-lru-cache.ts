/**
 * Map-based cache with a per-cache TTL and a hard size limit (least-recently-used eviction).
 *
 * The size limit is not optional: at ~86,000 new tokens/day, any per-mint structure without
 * one is a memory leak. `ttlMs: Infinity` means "never expires" (immutable data), but the
 * entry can still be evicted by size.
 */
import { millisValue, systemClock, type Clock } from '../core/time.js';

export interface TtlLruCacheOptions {
  readonly maxEntries: number;
  readonly ttlMs: number;
}

export class TtlLruCache<K, V> {
  // Map iterates in insertion order: re-inserting on read makes the first key the LRU one.
  private readonly entries = new Map<K, { readonly value: V; readonly expiresAt: number }>();

  constructor(
    private readonly options: TtlLruCacheOptions,
    private readonly clock: Clock = systemClock,
  ) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1 || !(options.ttlMs > 0)) {
      throw new RangeError('TtlLruCache needs maxEntries >= 1 and ttlMs > 0');
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    if (millisValue(this.clock()) >= entry.expiresAt) return undefined;
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: millisValue(this.clock()) + this.options.ttlMs });
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.options.maxEntries) break;
      this.entries.delete(oldest);
    }
  }
}
