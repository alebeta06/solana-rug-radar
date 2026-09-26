/**
 * USD price of each quote asset (SOL, USDC, and the dozens of tokens other tokens are paired
 * against), learned from the stream itself: a `liquidity` event carries both the raw quote amount
 * and its USD value, so `quote_usd / (quote_amount / 10^decimals)` is the quote's USD price at
 * that position. Needed to turn raw reserves (lamports) into USD liquidity.
 *
 * Measured over 10.5 h (2026-09-25): SOL p1–p99 = $115.96–$121.62, so a price that is a few
 * minutes old is good to ~1%. Latest position wins, so late events never overwrite fresher prices.
 */
import { Decimal } from '../core/schema.js';
import { comparePositions, type Position } from './order.js';

export const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';

export interface QuotePrice {
  readonly usdPerUnit: Decimal;
  readonly decimals: number;
  readonly position: Position;
}

export class QuotePrices {
  private readonly prices = new Map<string, QuotePrice>();

  constructor(private readonly maxEntries = 10_000) {}

  get size(): number {
    return this.prices.size;
  }

  /**
   * Records the price implied by a raw amount and its USD value. Ignores zero amounts and zero
   * USD (Solami sends "0" when it has no price for that side).
   */
  observe(quoteMint: string, rawAmount: bigint, decimals: number, usd: Decimal, position: Position): Decimal | null {
    if (rawAmount <= 0n || !usd.gt(0)) return null;
    const usdPerUnit = usd.div(toUnits(rawAmount, decimals));
    const current = this.prices.get(quoteMint);
    if (current === undefined || comparePositions(position, current.position) > 0) {
      // Re-insert so Map order = least recently updated first: SOL, updated every second, is never evicted.
      this.prices.delete(quoteMint);
      this.prices.set(quoteMint, { usdPerUnit, decimals, position });
      if (this.prices.size > this.maxEntries) {
        const stalest = this.prices.keys().next().value;
        if (stalest !== undefined) this.prices.delete(stalest);
      }
    }
    return usdPerUnit;
  }

  get(quoteMint: string): QuotePrice | undefined {
    return this.prices.get(quoteMint);
  }
}

export function toUnits(raw: bigint, decimals: number): Decimal {
  return new Decimal(raw.toString()).div(new Decimal(10).pow(decimals));
}
