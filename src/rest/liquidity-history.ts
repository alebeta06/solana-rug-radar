/**
 * Time series of `liquidity_usd` readings per mint.
 *
 * A liquidity collapse is an EVENT in time, not a state: a token at $3 of liquidity may have
 * been born weak or may have been drained. Only the history tells them apart. Bounded twice:
 * readings per mint (ring buffer) and number of mints (LRU).
 */
import type { Decimal } from 'decimal.js';
import { systemClock, type Clock, type UnixMillis } from '../core/time.js';
import { TtlLruCache } from './ttl-lru-cache.js';

export interface LiquidityReading {
  /** When WE observed it (dev-history gives no per-token timestamp for these values). */
  readonly observedAt: UnixMillis;
  readonly liquidityUsd: Decimal;
  readonly holders: number;
}

export interface LiquidityHistoryOptions {
  readonly maxMints: number;
  readonly maxReadingsPerMint: number;
}

export class LiquidityHistory {
  private readonly byMint: TtlLruCache<string, LiquidityReading[]>;

  constructor(
    private readonly options: LiquidityHistoryOptions,
    clock: Clock = systemClock,
  ) {
    if (!Number.isInteger(options.maxReadingsPerMint) || options.maxReadingsPerMint < 1) {
      throw new RangeError('LiquidityHistory needs maxReadingsPerMint >= 1');
    }
    this.byMint = new TtlLruCache({ maxEntries: options.maxMints, ttlMs: Infinity }, clock);
  }

  record(mint: string, reading: LiquidityReading): void {
    const readings = this.byMint.get(mint) ?? [];
    readings.push(reading);
    if (readings.length > this.options.maxReadingsPerMint) {
      readings.splice(0, readings.length - this.options.maxReadingsPerMint);
    }
    this.byMint.set(mint, readings);
  }

  /** Oldest first. */
  readings(mint: string): readonly LiquidityReading[] {
    return this.byMint.get(mint) ?? [];
  }
}
