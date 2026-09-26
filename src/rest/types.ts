/**
 * Normalized REST responses. Same conventions as src/events/types.ts.
 * Shapes typed against the real `GET /data/token/security` and `/data/token/dev-history`
 * responses captured during research.
 */
import type { Decimal } from 'decimal.js';
import type { UnixMillis, UnixSeconds } from '../core/time.js';

/**
 * Immutable facts about a mint. Cached forever (bounded only by size).
 * Filled from dev-history: the queried mint gets every field; the creator's other tokens
 * listed in the same response get everything except `launchpad`.
 */
export interface TokenIdentity {
  readonly mint: string;
  readonly creator: string;
  readonly createdTime: UnixSeconds;
  readonly launchpad: string | null;
  readonly name: string | null;
  readonly symbol: string | null;
}

export interface TokenSecurity {
  readonly mint: string;
  readonly mintAuthority: string | null;
  readonly freezeAuthority: string | null;
  readonly token2022: boolean;
  readonly metadataMutable: boolean | null;
  readonly extensions: readonly string[];
  readonly transferFeePct: Decimal | null;
  readonly nonTransferable: boolean;
  /** Units (fraction vs percent) not confirmed by Solami; compare only against itself. */
  readonly totalTaxPct: Decimal;
  readonly taxBreakdown: {
    readonly transferFeePct: Decimal;
    readonly swapFeePct: Decimal;
    readonly tipPct: Decimal;
  };
  readonly creator: string;
  readonly creatorPct: Decimal;
  /**
   * CAUTION: counts the liquidity pool as a holder, so "100" is normal for healthy tokens.
   * Useless as a signal unless the pool's share is discounted first.
   */
  readonly top10Pct: Decimal;
  readonly fetchedAt: UnixMillis;
}

export interface CreatorToken {
  readonly mint: string;
  readonly name: string;
  readonly symbol: string;
  readonly dex: string;
  readonly createdTime: UnixSeconds;
  readonly graduated: boolean;
  /** null when not graduated (raw value is 0, not a 1970 date). */
  readonly graduatedTime: UnixSeconds | null;
  /** null when Solami has no ATH for the token (seen in real answers). */
  readonly athUsd: Decimal | null;
  readonly athMcapUsd: Decimal | null;
  readonly priceUsd: Decimal;
  readonly liquidityUsd: Decimal;
  readonly holders: number;
  readonly totalFeesUsd: Decimal;
  readonly volume1hUsd: Decimal;
  readonly bundlersCount: number;
  /** true for the mint that was queried. */
  readonly isCurrent: boolean;
}

/**
 * dev-history takes a MINT but answers about its CREATOR, so it is cached by creator:
 * the 48 tokens of one operator cost one request per TTL, not 48.
 */
export interface CreatorHistory {
  readonly creator: string;
  readonly tokensLaunched: number;
  readonly migrated: number;
  readonly firstLaunch: UnixSeconds;
  readonly lastLaunch: UnixSeconds;
  readonly scanned: number;
  /** true if Solami cut the `tokens` list short. */
  readonly truncated: boolean;
  readonly tokens: readonly CreatorToken[];
  readonly fetchedAt: UnixMillis;
}
