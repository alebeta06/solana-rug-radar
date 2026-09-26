/**
 * The memory (phase 3): follows each token through its lifecycle and accumulates each
 * creator's history. Consumes normalized events from any EventSource plus dev-history answers.
 *
 * Time: the store's "now" is the WATERMARK, the newest event time seen (capped near the local
 * receive time so one bogus future timestamp cannot expire everything). Windows and eviction run
 * on event time, so a 10-hour replay behaves exactly like 10 hours live.
 *
 * Order: nothing depends on arrival order. Stages only move forward, "time of" facts keep the
 * earliest value, superseding readings compare on-chain positions, and launches are keyed by
 * mint. Replayed/backfilled duplicates change nothing. Events about a token we don't know yet
 * wait in a bounded buffer (./pending.ts).
 *
 * Bounded: see sweep().
 */
import type { AppConfig } from '../config.js';
import {
  elapsedSeconds,
  millisToSeconds,
  secondsValue,
  unixSeconds,
  type UnixSeconds,
} from '../core/time.js';
import type {
  GraduationEvent,
  LiquidityEvent,
  MemeEvent,
  PoolCreateEvent,
  SolamiEvent,
  SwapEvent,
  TokenCreateEvent,
} from '../events/types.js';
import type { CreatorHistory } from '../rest/types.js';
import { launchesInWindow, mergeOutcome, newCreator, recordLaunch, seen } from './creator-state.js';
import { timePosition, txPosition } from './order.js';
import { PendingEvents } from './pending.js';
import { QuotePrices, toUnits, WRAPPED_SOL } from './quote-prices.js';
import { addReading, earliest, newToken, observePool, outcomeOf, raiseStage, touch } from './token-state.js';
import { STAGE_RANK, type CreatorState, type LiquidityReading, type TokenStage, type TokenState } from './types.js';

type TrackedEvent = TokenCreateEvent | PoolCreateEvent | GraduationEvent | LiquidityEvent | MemeEvent | SwapEvent;
type PairEvent = PoolCreateEvent | LiquidityEvent;

export interface StateStoreOptions {
  readonly state: AppConfig['state'];
  readonly launchBurst: AppConfig['detection']['launchBurst'];
}

export interface StateStats {
  readonly watermark: UnixSeconds | null;
  readonly tokens: { readonly tracked: number } & Readonly<Record<TokenStage, number>>;
  readonly creators: { readonly known: number; readonly serial: number; readonly overThresholdNow: number };
  readonly launchesSeen: number;
  readonly graduationsSeen: number;
  readonly readings: number;
  readonly lateEvents: number;
  readonly unpricedReadings: number;
  readonly pending: { readonly mints: number; readonly held: number; readonly released: number; readonly expired: number };
  readonly evicted: { readonly tokens: number; readonly creators: number };
}

const TRACKED_TYPES = new Set(['token_create', 'pool_create', 'graduation', 'liquidity', 'meme', 'swap']);
const MINUTE = 60;
const HOUR = 3600;

export class StateStore {
  readonly tokens = new Map<string, TokenState>();
  readonly creators = new Map<string, CreatorState>();
  readonly quotePrices = new QuotePrices();
  private readonly pending: PendingEvents<PairEvent>;
  private watermarkValue: UnixSeconds | null = null;
  private lastSweep: UnixSeconds | null = null;
  private readonly counters = {
    launchesSeen: 0,
    graduationsSeen: 0,
    lateEvents: 0,
    unpricedReadings: 0,
    evictedTokens: 0,
    evictedCreators: 0,
  };

  constructor(private readonly options: StateStoreOptions) {
    this.pending = new PendingEvents(options.state.pending);
  }

  get watermark(): UnixSeconds | null {
    return this.watermarkValue;
  }

  get windowSeconds(): number {
    return this.options.launchBurst.windowHours * HOUR;
  }

  token(mint: string): TokenState | undefined {
    return this.tokens.get(mint);
  }

  creator(address: string): CreatorState | undefined {
    return this.creators.get(address);
  }

  /** Signal-1 raw material: launches by `creator` inside the burst window ending at the watermark. */
  launchesInWindow(address: string): number {
    const creator = this.creators.get(address);
    const now = this.watermarkValue;
    return creator === undefined || now === null ? 0 : launchesInWindow(creator, now, this.windowSeconds);
  }

  apply(event: SolamiEvent): void {
    if (!TRACKED_TYPES.has(event.type)) return;
    const e = event as TrackedEvent;
    this.advance(e);
    this.applyTracked(e);
    this.maybeSweep();
  }

  private applyTracked(e: TrackedEvent): void {
    switch (e.type) {
      case 'token_create':
        return this.onTokenCreate(e);
      case 'meme':
        return this.onMeme(e);
      case 'graduation':
        return this.onGraduation(e);
      case 'pool_create':
      case 'liquidity':
        return this.onPairEvent(e);
      case 'swap':
        return this.onSwap(e);
    }
  }

  private advance(e: TrackedEvent): void {
    const received = secondsValue(millisToSeconds(e.receivedAt));
    const at = Math.min(secondsValue(e.blockTime), received + this.options.state.maxFutureSkewSeconds);
    const wm = this.watermarkValue;
    if (wm !== null && secondsValue(wm) - secondsValue(e.blockTime) > this.options.state.lateAfterSeconds) {
      this.counters.lateEvents += 1;
    }
    if (wm === null || at > secondsValue(wm)) this.watermarkValue = unixSeconds(at);
  }

  private onTokenCreate(e: TokenCreateEvent): void {
    const creator = this.ensureCreator(e.creator, e.blockTime);
    const before = creator.launches.get(e.mint)?.source;
    const launch = recordLaunch(creator, e.mint, e.blockTime, 'stream', this.options.state.maxLaunchesPerCreator);
    if (before !== 'stream') this.counters.launchesSeen += 1;
    this.updateSerial(creator);
    // Too old to be alive (e.g. replayed after eviction): it still counts as a launch, nothing more.
    if (this.tooOldToTrack(e.mint, e.blockTime, 'created')) return;

    const token = this.ensureToken(e.mint, e.blockTime);
    // The launch record already holds the earliest of stream and dev-history, whichever came first.
    token.createdAt = earliest(token.createdAt, launch.createdAt ?? e.blockTime);
    token.creator = e.creator;
    token.launchpad = e.dex;
    token.name = e.name;
    token.symbol = e.symbol;
    token.quoteMint = e.mint === e.baseMint ? e.quoteMint : e.baseMint;
    observePool(token, e.pool, e.dex, e.blockTime, null, this.options.state.maxPoolsPerToken);
    this.release(e.mint);
  }

  private onMeme(e: MemeEvent): void {
    if (this.tooOldToTrack(e.mint, e.blockTime, 'curve')) return;
    const token = this.ensureToken(e.mint, e.blockTime);
    token.creator ??= e.creator ?? e.metadata?.creator ?? null;
    token.launchpad ??= e.launchpad;
    token.name ??= e.metadata?.name ?? null;
    token.symbol ??= e.metadata?.symbol ?? null;
    raiseStage(token, 'curve');

    const position = timePosition(e.blockTime);
    const newer = token.progressPosition === null ? 1 : position[0] - token.progressPosition[0];
    if (newer > 0 || (newer === 0 && token.progressPct !== null && e.progressPct.gt(token.progressPct))) {
      token.progressPct = e.progressPct;
      token.progressPosition = position;
    }

    const quote = token.quoteMint ?? WRAPPED_SOL;
    const price = this.quotePrices.get(quote);
    if (price === undefined) {
      this.counters.unpricedReadings += 1;
    } else {
      const liquidityUsd = toUnits(e.quoteReserve, price.decimals).mul(price.usdPerUnit);
      const reading = { at: e.blockTime, position, source: 'curve', pool: null, liquidityUsd, holders: null } as const;
      this.addReading(token, reading);
    }
    this.release(e.mint);
  }

  private onGraduation(e: GraduationEvent): void {
    seen(this.ensureCreator(e.creator, e.blockTime), e.blockTime);
    if (this.tooOldToTrack(e.mint, e.blockTime, 'graduated')) return;
    const token = this.ensureToken(e.mint, e.blockTime);
    token.creator ??= e.creator;
    token.launchpad ??= e.launchpad;
    // A curve token evicted while idle can graduate hours later: its birth is in the creator's history.
    token.createdAt ??= this.creators.get(e.creator)?.launches.get(e.mint)?.createdAt ?? null;
    this.markGraduated(token, e.blockTime);
    token.graduationPool ??= e.pool;
    observePool(token, e.pool, e.dex, e.blockTime, null, this.options.state.maxPoolsPerToken);
    this.release(e.mint);
  }

  private markGraduated(token: TokenState, at: UnixSeconds): void {
    if (token.stage !== 'graduated') this.counters.graduationsSeen += 1;
    raiseStage(token, 'graduated');
    token.graduatedAt = earliest(token.graduatedAt, at);
  }

  /** `pool_create` / `liquidity`: the token is whichever side of the pair we follow. */
  private onPairEvent(e: PairEvent): void {
    const tokenIsBase = this.tokens.has(e.baseMint);
    const mint = tokenIsBase ? e.baseMint : this.tokens.has(e.quoteMint) ? e.quoteMint : null;
    if (e.type === 'liquidity') this.learnPrices(e, mint !== null && !tokenIsBase);
    if (mint === null) {
      const candidates = [e.baseMint, e.quoteMint].filter((m) => m !== WRAPPED_SOL);
      this.pending.hold(candidates, e, secondsValue(e.blockTime));
      return;
    }
    const token = this.ensureToken(mint, e.blockTime);
    if (e.type === 'pool_create') {
      observePool(token, e.pool, e.dex, e.blockTime, null, this.options.state.maxPoolsPerToken);
      return;
    }
    const quote = tokenIsBase
      ? { mint: e.quoteMint, reserve: e.quoteReserve, decimals: e.quoteDecimals }
      : { mint: e.baseMint, reserve: e.baseReserve, decimals: e.baseDecimals };
    this.addPoolReading(token, e, quote);
  }

  /**
   * Swaps move the pool reserves (a drain by selling never emits a liquidity `remove`). Only
   * swaps of tokens we follow count; the rest of the firehose (~440/s) costs two Map lookups.
   * Not held as pending (99% of swaps are about tokens we never follow and would flush the
   * buffer): a swap before its token is dropped; the next swap gives the current value again.
   */
  private onSwap(e: SwapEvent): void {
    const tokenIsMint = this.tokens.has(e.mint);
    const mint = tokenIsMint ? e.mint : this.tokens.has(e.quoteMint) ? e.quoteMint : null;
    if (mint === null) return;
    const token = this.ensureToken(mint, e.blockTime);
    const quote = tokenIsMint
      ? { mint: e.quoteMint, reserve: e.quoteReserve, decimals: e.quoteDecimals, amount: e.quoteAmount }
      : { mint: e.mint, reserve: e.baseReserve, decimals: e.baseDecimals, amount: e.baseAmount };
    // Both legs of a swap are worth `volume_usd`: teaches the price of exotic quote tokens too.
    this.quotePrices.observe(quote.mint, quote.amount, quote.decimals, e.volumeUsd, txPosition(e));
    this.addPoolReading(token, e, quote);
  }

  private addPoolReading(
    token: TokenState,
    e: LiquidityEvent | SwapEvent,
    quote: { readonly mint: string; readonly reserve: bigint; readonly decimals: number },
  ): void {
    const price = this.quotePrices.get(quote.mint);
    let reading = null;
    if (price === undefined) {
      this.counters.unpricedReadings += 1;
    } else {
      const liquidityUsd = toUnits(quote.reserve, quote.decimals).mul(price.usdPerUnit);
      reading = { at: e.blockTime, position: txPosition(e), source: 'pool', pool: e.pool, liquidityUsd, holders: null } as const;
      this.addReading(token, reading);
    }
    observePool(token, e.pool, e.dex, e.blockTime, reading, this.options.state.maxPoolsPerToken);
  }

  private addReading(token: TokenState, reading: LiquidityReading): void {
    addReading(token, reading, this.options.state.maxReadingsPerToken, this.options.state.readingBucketSeconds);
  }

  /** Every liquidity event teaches the USD price of its quote side (and of its base side when our token is the quote). */
  private learnPrices(e: LiquidityEvent, alsoBase: boolean): void {
    const position = txPosition(e);
    this.quotePrices.observe(e.quoteMint, e.quoteAmount, e.quoteDecimals, e.quoteUsd, position);
    if (alsoBase) this.quotePrices.observe(e.baseMint, e.baseAmount, e.baseDecimals, e.baseUsd, position);
  }

  /** Merges a dev-history answer: launches before we started listening, holders, Solami's liquidity. */
  applyCreatorHistory(history: CreatorHistory): void {
    const at = millisToSeconds(history.fetchedAt);
    const max = this.options.state.maxLaunchesPerCreator;
    const creator = this.ensureCreator(history.creator, history.lastLaunch);
    seen(creator, history.firstLaunch);
    seen(creator, history.lastLaunch);
    creator.rest = { tokensLaunched: history.tokensLaunched, migrated: history.migrated, fetchedAt: at };
    for (const t of history.tokens) {
      recordLaunch(creator, t.mint, t.createdTime, 'rest', max);
      const token = this.tokens.get(t.mint);
      if (token === undefined) {
        mergeOutcome(
          creator,
          t.mint,
          { stage: t.graduated ? 'graduated' : undefined, restLiquidityUsd: t.liquidityUsd, holders: t.holders, athMcapUsd: t.athMcapUsd, at },
          'rest',
          max,
        );
        continue;
      }
      token.creator ??= history.creator;
      token.createdAt = earliest(token.createdAt, t.createdTime);
      token.holders = t.holders;
      token.athMcapUsd = t.athMcapUsd;
      if (t.graduated) this.markGraduated(token, t.graduatedTime ?? at);
      // Not `touch`: being asked about is not activity, or polled suspects would never be evicted.
      const reading = { at, position: timePosition(at), source: 'rest', pool: null, liquidityUsd: t.liquidityUsd, holders: t.holders } as const;
      this.addReading(token, reading);
    }
    this.updateSerial(creator);
  }

  private updateSerial(creator: CreatorState): void {
    const now = this.watermarkValue;
    if (creator.serial || now === null) return;
    if (launchesInWindow(creator, now, this.windowSeconds) > this.options.launchBurst.maxNormalLaunches) {
      creator.serial = true;
    }
  }

  /** An unknown token whose event is already past its idle TTL would be evicted at once. */
  private tooOldToTrack(mint: string, at: UnixSeconds, stage: TokenStage): boolean {
    const now = this.watermarkValue;
    if (now === null || this.tokens.has(mint)) return false;
    return elapsedSeconds(at, now) > this.idleTtlSeconds(stage);
  }

  private idleTtlSeconds(stage: TokenStage): number {
    const { tokenIdleMinutes } = this.options.state;
    return (stage === 'graduated' ? tokenIdleMinutes.graduated : tokenIdleMinutes.curve) * MINUTE;
  }

  private ensureToken(mint: string, at: UnixSeconds): TokenState {
    let token = this.tokens.get(mint);
    if (token === undefined) {
      token = newToken(mint, at);
      this.tokens.set(mint, token);
    } else {
      touch(token, at);
    }
    return token;
  }

  private ensureCreator(address: string, at: UnixSeconds): CreatorState {
    let creator = this.creators.get(address);
    if (creator === undefined) {
      creator = newCreator(address, at);
      this.creators.set(address, creator);
    }
    return creator;
  }

  /** Re-applies events that were waiting for this token. */
  private release(mint: string): void {
    for (const event of this.pending.take(mint)) this.onPairEvent(event);
  }

  private maybeSweep(): void {
    const now = this.watermarkValue;
    if (now === null) return;
    if (this.lastSweep === null) {
      this.lastSweep = now;
    } else if (elapsedSeconds(this.lastSweep, now) >= this.options.state.sweepEverySeconds) {
      this.sweep();
    }
  }

  /**
   * Eviction policy (all in event time):
   * - Tokens: idle TTL by stage. A curve token with no activity for `tokenIdleMinutes.curve` is
   *   dead (measured: 90% of non-graduated tokens have no event after 5 min, 99% after 5.2 h);
   *   graduated ones get `tokenIdleMinutes.graduated` because that is where the drain happens
   *   (graduation → last liquidity event p90 = 14 min, p99 = 9.9 h). An evicted token is folded
   *   into its creator's LaunchRecord, so "what became of it" survives. Over `maxTokens`, curve
   *   tokens go first, then the least recently active.
   * - Creators: NOT by the token rule. Kept `creatorRetentionHours.default` (>= the burst window,
   *   so the count stays exact) after last seen, and `...serial` if they ever crossed the
   *   threshold: those are exactly what we must not forget. Over `maxCreators`, non-serial
   *   creators go first, least recently seen first.
   */
  sweep(): void {
    const now = this.watermarkValue;
    if (now === null) return;
    this.lastSweep = now;
    const { creatorRetentionHours, maxTokens, maxCreators } = this.options.state;
    this.pending.expire(secondsValue(now));

    for (const token of this.tokens.values()) {
      if (elapsedSeconds(token.lastActivity, now) > this.idleTtlSeconds(token.stage)) this.evictToken(token);
    }
    if (this.tokens.size > maxTokens) {
      const byValue = [...this.tokens.values()].sort(
        (a, b) => STAGE_RANK[a.stage] - STAGE_RANK[b.stage] || secondsValue(a.lastActivity) - secondsValue(b.lastActivity),
      );
      for (const token of byValue.slice(0, this.tokens.size - maxTokens)) this.evictToken(token);
    }

    for (const creator of this.creators.values()) {
      const retention = (creator.serial ? creatorRetentionHours.serial : creatorRetentionHours.default) * HOUR;
      if (elapsedSeconds(creator.lastSeen, now) > retention) this.evictCreator(creator);
    }
    if (this.creators.size > maxCreators) {
      const byValue = [...this.creators.values()].sort(
        (a, b) => Number(a.serial) - Number(b.serial) || secondsValue(a.lastSeen) - secondsValue(b.lastSeen),
      );
      for (const creator of byValue.slice(0, this.creators.size - maxCreators)) this.evictCreator(creator);
    }
  }

  private evictToken(token: TokenState): void {
    const creator = token.creator === null ? undefined : this.creators.get(token.creator);
    if (creator !== undefined) {
      mergeOutcome(creator, token.mint, outcomeOf(token), 'stream', this.options.state.maxLaunchesPerCreator);
    }
    this.tokens.delete(token.mint);
    this.counters.evictedTokens += 1;
  }

  private evictCreator(creator: CreatorState): void {
    this.creators.delete(creator.creator);
    this.counters.evictedCreators += 1;
  }

  stats(): StateStats {
    const byStage: Record<TokenStage, number> = { created: 0, curve: 0, graduated: 0 };
    let readings = 0;
    for (const token of this.tokens.values()) {
      byStage[token.stage] += 1;
      readings += token.readings.length;
    }
    let serial = 0;
    let overThresholdNow = 0;
    for (const creator of this.creators.values()) {
      if (creator.serial) serial += 1;
      if (creator.serial && this.launchesInWindow(creator.creator) > this.options.launchBurst.maxNormalLaunches) {
        overThresholdNow += 1;
      }
    }
    const c = this.counters;
    return {
      watermark: this.watermarkValue,
      tokens: { tracked: this.tokens.size, ...byStage },
      creators: { known: this.creators.size, serial, overThresholdNow },
      launchesSeen: c.launchesSeen,
      graduationsSeen: c.graduationsSeen,
      readings,
      lateEvents: c.lateEvents,
      unpricedReadings: c.unpricedReadings,
      pending: { mints: this.pending.mints, held: this.pending.held, released: this.pending.released, expired: this.pending.expired },
      evicted: { tokens: c.evictedTokens, creators: c.evictedCreators },
    };
  }
}
