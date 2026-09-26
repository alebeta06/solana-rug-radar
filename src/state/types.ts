/**
 * What the system remembers (phase 3). Phases 4–5 read these; only the store mutates them.
 *
 * Two kinds of memory with different lifetimes:
 * - TokenState: the full lifecycle of one token (stage, pools, liquidity readings). Short-lived:
 *   ~41,000 launches/day, most dead within minutes.
 * - CreatorState: what each creator launched and what became of each launch. Long-lived: a token
 *   is folded into a compact LaunchRecord when evicted, so the creator's history survives it.
 */
import type { Decimal } from 'decimal.js';
import type { UnixSeconds } from '../core/time.js';
import type { Position } from './order.js';

/**
 * Monotone: a token only moves forward (created < curve < graduated), whatever the arrival
 * order. "Has a pool" is not a stage: launchpads like meteora_dbc create the curve pool at birth.
 */
export type TokenStage = 'created' | 'curve' | 'graduated';
export const STAGE_RANK: Readonly<Record<TokenStage, number>> = { created: 0, curve: 1, graduated: 2 };

/**
 * - `curve`: SOL (or other quote) locked in the launchpad bonding curve, from `meme`.
 * - `pool`: quote-side reserve of one AMM/launchpad pool after a `liquidity` or `swap` event.
 *   Swaps matter: a drain by selling never shows up as a liquidity `remove`.
 * - `rest`: Solami's own `liquidity_usd` from dev-history (with holders).
 * Stream readings are the QUOTE SIDE only, in USD; `rest` is Solami's figure. Do not mix them in
 * one threshold without knowing which is which.
 */
export type ReadingSource = 'curve' | 'pool' | 'rest';

export interface LiquidityReading {
  readonly at: UnixSeconds;
  readonly position: Position;
  readonly source: ReadingSource;
  /** Pool address for `pool`; null for `curve` and `rest`. */
  readonly pool: string | null;
  readonly liquidityUsd: Decimal;
  /** Only dev-history knows holders; the stream has no holder counts at all. */
  readonly holders: number | null;
}

export interface PoolState {
  readonly pool: string;
  dex: string | null;
  /** Latest reading of this pool by on-chain position (not by arrival). */
  latest: LiquidityReading | null;
  lastSeen: UnixSeconds;
}

export interface TokenState {
  readonly mint: string;
  creator: string | null;
  /** `token_create` block time. null until seen (e.g. the graduation arrived first). */
  createdAt: UnixSeconds | null;
  launchpad: string | null;
  name: string | null;
  symbol: string | null;
  /** The other side of the launch pair (usually wrapped SOL). */
  quoteMint: string | null;
  stage: TokenStage;
  graduatedAt: UnixSeconds | null;
  graduationPool: string | null;
  progressPct: Decimal | null;
  progressPosition: Position | null;
  readonly pools: Map<string, PoolState>;
  /**
   * Oldest first, ordered by (time, position), bounded (newest kept). One reading per source,
   * pool and time bucket: the latest of that bucket, like a candle's close.
   */
  readonly readings: LiquidityReading[];
  /** Max single reading ever seen, including readings replaced or dropped from the list. */
  peakLiquidityUsd: Decimal | null;
  /** When the peak was seen (earliest, on ties). */
  peakAt: UnixSeconds | null;
  /** From dev-history. */
  holders: number | null;
  athMcapUsd: Decimal | null;
  firstSeen: UnixSeconds;
  lastActivity: UnixSeconds;
}

/** What became of a launch, kept on the creator after the token itself is forgotten. */
export interface TokenOutcome {
  readonly stage: TokenStage;
  readonly peakLiquidityUsd: Decimal | null;
  /** Stream view: sum of the pools' latest readings (or the last curve reading). */
  readonly lastLiquidityUsd: Decimal | null;
  /** Solami's view (dev-history), when it was asked. */
  readonly restLiquidityUsd: Decimal | null;
  readonly holders: number | null;
  readonly athMcapUsd: Decimal | null;
  readonly at: UnixSeconds;
}

export interface LaunchRecord {
  readonly mint: string;
  /** null if we saw the token but never its creation time (created before we started listening). */
  createdAt: UnixSeconds | null;
  /** Who told us about it: our own stream, or dev-history (launches before we started). */
  source: 'stream' | 'rest';
  outcome: TokenOutcome | null;
}

export interface CreatorState {
  readonly creator: string;
  readonly launches: Map<string, LaunchRecord>;
  firstSeen: UnixSeconds;
  lastSeen: UnixSeconds;
  /** Sticky: was ever over the launch-burst threshold. Retained much longer (never forget these). */
  serial: boolean;
  /** Lifetime numbers from dev-history (count what happened before we started listening). */
  rest: { readonly tokensLaunched: number; readonly migrated: number; readonly fetchedAt: UnixSeconds } | null;
  /** Last time the enricher dispatched a dev-history request for this creator. */
  restRequestedAt: UnixSeconds | null;
}
