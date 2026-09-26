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

/** Stream view of liquidity now: sum of each pool's latest reading, else the last curve reading. */
export function currentLiquidityUsd(token: TokenState): Decimal | null {
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
    peakLiquidityUsd: token.peakLiquidityUsd,
    lastLiquidityUsd: currentLiquidityUsd(token),
    restLiquidityUsd: latestRestReading(token)?.liquidityUsd ?? null,
    holders: token.holders,
    athMcapUsd: token.athMcapUsd,
    at: token.lastActivity,
  };
}
