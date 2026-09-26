/**
 * Order-independent updates on one CreatorState (same guarantees as ./token-state.ts).
 *
 * This is the memory behind signal 1 ("launches by this creator in 24 h"): launches are keyed
 * by mint, so a backfilled or replayed `token_create` never counts twice, and launches learned
 * from dev-history (before we started listening) count the same as those we saw.
 */
import { elapsedSeconds, type UnixSeconds } from '../core/time.js';
import { earliest } from './token-state.js';
import { STAGE_RANK, type CreatorState, type LaunchRecord, type TokenOutcome } from './types.js';

export function newCreator(creator: string, at: UnixSeconds): CreatorState {
  return {
    creator,
    launches: new Map(),
    firstSeen: at,
    lastSeen: at,
    serial: false,
    rest: null,
    restRequestedAt: null,
  };
}

export function seen(creator: CreatorState, at: UnixSeconds): void {
  if (at > creator.lastSeen) creator.lastSeen = at;
  if (at < creator.firstSeen) creator.firstSeen = at;
}

export function recordLaunch(
  creator: CreatorState,
  mint: string,
  createdAt: UnixSeconds | null,
  source: LaunchRecord['source'],
  maxLaunches: number,
): LaunchRecord {
  let launch = creator.launches.get(mint);
  if (launch === undefined) {
    launch = { mint, createdAt, source, outcome: null };
    creator.launches.set(mint, launch);
    if (creator.launches.size > maxLaunches) dropOldestLaunch(creator);
  } else {
    if (createdAt !== null) launch.createdAt = earliest(launch.createdAt, createdAt);
    if (source === 'stream') launch.source = 'stream';
  }
  if (createdAt !== null) seen(creator, createdAt);
  return launch;
}

/** Keeps the newest launches; unknown creation times go first. */
function dropOldestLaunch(creator: CreatorState): void {
  let oldest: LaunchRecord | undefined;
  for (const launch of creator.launches.values()) {
    if (oldest === undefined || isOlder(launch, oldest)) oldest = launch;
  }
  if (oldest !== undefined) creator.launches.delete(oldest.mint);
}

function isOlder(a: LaunchRecord, b: LaunchRecord): boolean {
  if (a.createdAt === null || b.createdAt === null) {
    return a.createdAt === null && (b.createdAt !== null || a.mint < b.mint);
  }
  return a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.mint < b.mint);
}

/** Launches created less than `windowSeconds` before `now`. Unknown creation times never count. */
export function launchesInWindow(creator: CreatorState, now: UnixSeconds, windowSeconds: number): number {
  let count = 0;
  for (const { createdAt } of creator.launches.values()) {
    if (createdAt === null) continue;
    // A launch slightly "ahead" of now (REST wall clock vs stream watermark) still counts.
    if (elapsedSeconds(createdAt, now) < windowSeconds) count += 1;
  }
  return count;
}

const NO_OUTCOME = {
  stage: 'created',
  peakLiquidityUsd: null,
  lastLiquidityUsd: null,
  restLiquidityUsd: null,
  holders: null,
  athMcapUsd: null,
} as const;

/**
 * Updates what became of a launch. A token folded on eviction brings everything it knew; a
 * dev-history answer for a token we no longer track only brings Solami's fields. The stage
 * only moves forward.
 */
export function mergeOutcome(
  creator: CreatorState,
  mint: string,
  patch: Partial<TokenOutcome> & Pick<TokenOutcome, 'at'>,
  source: LaunchRecord['source'],
  maxLaunches: number,
): void {
  const launch = recordLaunch(creator, mint, null, source, maxLaunches);
  const previous: TokenOutcome = launch.outcome ?? { ...NO_OUTCOME, at: patch.at };
  // A missing or null field in the patch means "unknown here": keep what we had.
  const pick = <K extends keyof TokenOutcome>(key: K) => (patch[key] ?? previous[key]) as TokenOutcome[K];
  launch.outcome = {
    stage: patch.stage !== undefined && STAGE_RANK[patch.stage] > STAGE_RANK[previous.stage] ? patch.stage : previous.stage,
    peakLiquidityUsd: pick('peakLiquidityUsd'),
    lastLiquidityUsd: pick('lastLiquidityUsd'),
    restLiquidityUsd: pick('restLiquidityUsd'),
    holders: pick('holders'),
    athMcapUsd: pick('athMcapUsd'),
    at: patch.at > previous.at ? patch.at : previous.at,
  };
}
