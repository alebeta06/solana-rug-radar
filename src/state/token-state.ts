/**
 * Order-independent updates on one TokenState. Every function here gives the same result
 * whatever order the events arrive in, and applying the same event twice changes nothing
 * (delivery is at-least-once: backfill, warm start + live overlap). The tests check both.
 */
import type { Decimal } from 'decimal.js';
import { secondsValue, type UnixSeconds } from '../core/time.js';
import { comparePositions } from './order.js';
import {
  STAGE_RANK,
  type LiquidityReading,
  type PoolState,
  type TokenOutcome,
  type TokenStage,
  type TokenState,
} from './types.js';

export function newToken(mint: string, at: UnixSeconds): TokenState {
  return {
    mint,
    creator: null,
    createdAt: null,
    launchpad: null,
    name: null,
    symbol: null,
    quoteMint: null,
    stage: 'created',
    graduatedAt: null,
    graduationPool: null,
    progressPct: null,
    progressPosition: null,
    pools: new Map(),
    readings: [],
    peakLiquidityUsd: null,
    peakAt: null,
    tradablePeakUsd: null,
    holders: null,
    athMcapUsd: null,
    firstSeen: at,
    lastActivity: at,
  };
}

export function touch(token: TokenState, at: UnixSeconds): void {
  if (at > token.lastActivity) token.lastActivity = at;
  if (at < token.firstSeen) token.firstSeen = at;
}

export function raiseStage(token: TokenState, stage: TokenStage): void {
  if (STAGE_RANK[stage] > STAGE_RANK[token.stage]) token.stage = stage;
}

/** Earliest wins: two different values for a "time of" fact can only come from a replay mix-up. */
export function earliest(current: UnixSeconds | null, candidate: UnixSeconds): UnixSeconds {
  return current === null || candidate < current ? candidate : current;
}

/** Total order over readings, so the kept set does not depend on arrival order. */
export function compareReadings(a: LiquidityReading, b: LiquidityReading): number {
  return (
    comparePositions(a.position, b.position) ||
    a.source.localeCompare(b.source) ||
    (a.pool ?? '').localeCompare(b.pool ?? '') ||
    a.liquidityUsd.comparedTo(b.liquidityUsd) ||
    (a.holders ?? -1) - (b.holders ?? -1)
  );
}

/**
 * Inserts in (time, position) order, keeping ONE reading per (source, pool, bucket): the one
 * with the latest position. Keeps the newest `max`. Replaying the same reading is a no-op. The
 * peak counts every reading ever offered, even one replaced or too old to be kept.
 */
export function addReading(token: TokenState, reading: LiquidityReading, max: number, bucketSeconds: number): void {
  const peak = token.peakLiquidityUsd;
  if (peak === null || reading.liquidityUsd.gt(peak) || (reading.liquidityUsd.eq(peak) && token.peakAt !== null && reading.at < token.peakAt)) {
    token.peakLiquidityUsd = reading.liquidityUsd;
    token.peakAt = reading.at;
  }
  const list = token.readings;
  const bucket = Math.floor(secondsValue(reading.at) / bucketSeconds);
  const bucketStart = bucket * bucketSeconds;
  for (let j = list.length - 1; j >= 0; j -= 1) {
    const other = list[j];
    if (other === undefined || secondsValue(other.at) < bucketStart) break;
    if (other.source !== reading.source || other.pool !== reading.pool) continue;
    if (Math.floor(secondsValue(other.at) / bucketSeconds) !== bucket) continue;
    if (compareReadings(reading, other) <= 0) return; // the bucket already holds a later reading
    list.splice(j, 1);
    break;
  }
  let i = list.length;
  // Usually appended: walk back from the end.
  while (i > 0) {
    const previous = list[i - 1];
    if (previous === undefined || compareReadings(previous, reading) < 0) break;
    i -= 1;
  }
  if (list.length >= max && i === 0) return; // older than everything kept
  list.splice(i, 0, reading);
  if (list.length > max) list.splice(0, list.length - max);
}

/**
 * Registers a pool (from `pool_create`, `graduation` or `liquidity`) and, if given, its newer
 * reading. At most `maxPools` per token: one real mint had 2,396 pools; the least recently
 * active pool is dropped.
 */
export function observePool(
  token: TokenState,
  pool: string,
  dex: string | null,
  at: UnixSeconds,
  reading: LiquidityReading | null,
  maxPools: number,
): void {
  let state = token.pools.get(pool);
  if (state === undefined) {
    state = { pool, dex, latest: null, lastSeen: at };
    token.pools.set(pool, state);
    if (token.pools.size > maxPools) dropStalestPool(token);
  }
  state.dex ??= dex;
  if (at > state.lastSeen) state.lastSeen = at;
  if (reading !== null && (state.latest === null || compareReadings(reading, state.latest) > 0)) {
    state.latest = reading;
    // The venue that TRADES the pool wins over whoever announced it: pump.fun's migration emits
    // `pool_create` with dex "pumpfun" for what then trades as "pumpswap". Tied to the latest
    // reading, so it stays order-independent.
    state.dex = dex;
  }
}

function dropStalestPool(token: TokenState): void {
  let stalest: PoolState | undefined;
  for (const candidate of token.pools.values()) {
    if (
      stalest === undefined ||
      candidate.lastSeen < stalest.lastSeen ||
      (candidate.lastSeen === stalest.lastSeen && candidate.pool < stalest.pool)
    ) {
      stalest = candidate;
    }
  }
  if (stalest !== undefined) token.pools.delete(stalest.pool);
}

/**
 * The launchpads' own bonding-curve pools. After graduation the money trades in the new pool, but
 * the curve pool can keep reserves nobody can trade against: meteora_dbc leaves ~11–14 SOL there.
 * Summing it made 486 drained tokens of the 2026-09-26 capture look alive
 * (docs/ANALISIS_calibracion.md §0).
 */
export const CURVE_DEXES: ReadonlySet<string> = new Set(['pumpfun', 'meteora_dbc', 'raydium_launchpad']);

/**
 * Liquidity a trader can actually sell into: sum of the latest reading of each NON-curve pool.
 * Only defined once graduated (before that, the curve IS the market); null if no such pool has a
 * priced reading yet.
 */
export function tradableLiquidityUsd(token: TokenState): Decimal | null {
  if (token.stage !== 'graduated') return null;
  let total: Decimal | null = null;
  for (const { dex, latest } of token.pools.values()) {
    if (latest === null || (dex !== null && CURVE_DEXES.has(dex))) continue;
    total = total === null ? latest.liquidityUsd : total.add(latest.liquidityUsd);
  }
  return total;
}

/**
 * Raises the tradable peak with one pool reading: the max single reading of any non-curve pool.
 * A max is order-independent (a sum over pools "at the time" is not: it depends on which reading
 * of each pool arrived first), and multi-pool tokens are rare enough not to matter.
 */
export function raiseTradablePeak(token: TokenState, dex: string | null, reading: LiquidityReading): void {
  if (dex !== null && CURVE_DEXES.has(dex)) return;
  if (token.tradablePeakUsd === null || reading.liquidityUsd.gt(token.tradablePeakUsd)) token.tradablePeakUsd = reading.liquidityUsd;
}

/**
 * Stream view of liquidity now. Graduated: tradable liquidity (curve pools excluded). Otherwise:
 * sum of each pool's latest reading, else the last curve reading.
 */
export function currentLiquidityUsd(token: TokenState): Decimal | null {
  if (token.stage === 'graduated') {
    const tradable = tradableLiquidityUsd(token);
    if (tradable !== null) return tradable;
  }
  let total: Decimal | null = null;
  for (const { latest } of token.pools.values()) {
    if (latest !== null) total = total === null ? latest.liquidityUsd : total.add(latest.liquidityUsd);
  }
  if (total !== null) return total;
  for (let i = token.readings.length - 1; i >= 0; i -= 1) {
    const reading = token.readings[i];
    if (reading?.source === 'curve') return reading.liquidityUsd;
  }
  return null;
}

export function latestRestReading(token: TokenState): LiquidityReading | null {
  for (let i = token.readings.length - 1; i >= 0; i -= 1) {
    const reading = token.readings[i];
    if (reading?.source === 'rest') return reading;
  }
  return null;
}

export function outcomeOf(token: TokenState): TokenOutcome {
  return {
    stage: token.stage,
    // Graduated: the same (tradable) basis as lastLiquidityUsd, or the two would not be comparable.
    peakLiquidityUsd: (token.stage === 'graduated' ? token.tradablePeakUsd : null) ?? token.peakLiquidityUsd,
    lastLiquidityUsd: currentLiquidityUsd(token),
    restLiquidityUsd: latestRestReading(token)?.liquidityUsd ?? null,
    holders: token.holders,
    athMcapUsd: token.athMcapUsd,
    at: token.lastActivity,
  };
}
