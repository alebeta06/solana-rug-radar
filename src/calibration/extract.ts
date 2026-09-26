/**
 * One pass over a capture (time-merged, see ./capture.ts) through the SAME memory as live
 * (StateStore + simulated enricher), collecting per-token features for the calibration report.
 * Writes data/calibration/<capture>.json; ./report.ts reads it (the pass takes minutes, the
 * report seconds).
 *
 * Usage: node dist/calibration/extract.js 20260926
 *        node --expose-gc dist/calibration/extract.js 20260926 --memory
 *          (no features: only the store + enricher, heap measured after a forced GC every
 *           30 min of event time, so the numbers are the retained set, not garbage)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { secondsValue } from '../core/time.js';
import type { SolamiEvent } from '../events/types.js';
import { Enricher } from '../state/enricher.js';
import { createStateStore, warmStart } from '../state/factory.js';
import { EnrichmentScheduler, type EnrichmentRequest } from '../state/scheduler.js';
import { currentLiquidityUsd, outcomeOf } from '../state/token-state.js';
import type { TokenOutcome } from '../state/types.js';
import { CURVE_DEXES, captureFiles, lifecycleMints, mergedReplay } from './capture.js';

const SOL = 'So11111111111111111111111111111111111111112';
const HAD = 1000;
const LOW = 5;
const SAMPLE_EVERY_SECONDS = 1800;

/** Liquidity event: [time, 0 add | 1 remove, provider, pool, dex, SOL moved | null, SOL reserve after | null]. */
export type LiqRow = [number, 0 | 1, string, string, string, number | null, number | null];

/** Latest state of one pool BY ON-CHAIN POSITION (a first version kept arrival order, and swaps of the
 *  same second as a drain, merged after it, made drained pools look full). */
export interface PoolLast { dex: string; t: number; pos: number[]; sol: number | null; base: number; priceUsd: number | null }


export interface TokenFeatures {
  creator: string | null;
  createdAt: number | null;
  launchpad: string | null;
  name: string | null;
  gradAt: number | null;
  gradDex: string | null;
  liq: LiqRow[];
  curveSwaps: number;
  curveSells: number;
  /** Swaps while graduated, flat: time, 1 = sell, trader id, SOL reserve after (-1 if not SOL). */
  sw: number[];
  quoteLegSwaps: number;
  collapseAt: number | null;
  collapseBy: string | null;
  collapseActor: string | null;
  pools: Record<string, PoolLast>;
  /** Tradable liquidity (graduated only, curve pools excluded), USD at the current SOL price. */
  tradablePeak: number | null;
  tradableLast: number | null;
  tradableCollapseAt: number | null;
  tradableCollapseBy: string | null;
  tradableCollapseActor: string | null;
  outcome?: { stage: string; peak: number | null; last: number | null; at: number };
}

export interface CaptureFeatures {
  capture: string;
  start: number;
  end: number;
  tokens: Record<string, TokenFeatures>;
  creators: Record<string, { launches: number; serial: boolean }>;
  samples: Record<string, unknown>[];
  enrichment: Record<string, unknown>;
  replay: Record<string, unknown>;
}

const features = new Map<string, TokenFeatures>();
const traderIds = new Map<string, number>();
function f(mint: string): TokenFeatures {
  let x = features.get(mint);
  if (x === undefined) {
    x = {
      creator: null, createdAt: null, launchpad: null, name: null, gradAt: null, gradDex: null, liq: [], curveSwaps: 0,
      curveSells: 0, sw: [], quoteLegSwaps: 0, collapseAt: null, collapseBy: null, collapseActor: null, pools: {},
      tradablePeak: null, tradableLast: null, tradableCollapseAt: null, tradableCollapseBy: null, tradableCollapseActor: null,
    };
    features.set(mint, x);
  }
  return x;
}
const sol = (amount: bigint, decimals: number) => Number(amount) / 10 ** decimals;

/** Scheduler that also records, per class, the wait and the age of the token when dispatched. */
class MeasuredScheduler extends EnrichmentScheduler {
  readonly waits: Record<string, number[]> = {};
  readonly ageAtDispatch: Record<string, number[]> = {};
  createdAt: (mint: string) => number | null = () => null;
  override take(now: number): EnrichmentRequest | null {
    const r = super.take(now);
    if (r !== null) {
      (this.waits[r.priority] ??= []).push(now - r.enqueuedAt);
      const c = this.createdAt(r.mint);
      if (c !== null) (this.ageAtDispatch[r.priority] ??= []).push(now - c);
    }
    return r;
  }
}

async function main(): Promise<void> {
  const prefix = process.argv[2];
  if (prefix === undefined) throw new Error('usage: extract.js <capture prefix, e.g. 20260926> [--memory]');
  const memoryOnly = process.argv.includes('--memory');
  const gc = (globalThis as { gc?: () => void }).gc;
  if (memoryOnly && gc === undefined) throw new Error('--memory needs node --expose-gc');
  const config = loadConfig();
  const capture = captureFiles('data/live', prefix);
  const started = Date.now();
  const mints = await lifecycleMints(capture);
  console.log(`capture ${prefix}: ${capture.lifecycle.length} lifecycle + ${capture.firehose.length} firehose files; ${mints.size} mints in lifecycle (${((Date.now() - started) / 1000).toFixed(0)} s)`);

  const store = createStateStore(config);
  const warm = process.argv.indexOf('--warm');
  if (warm !== -1) {
    const files = captureFiles('data/live', process.argv[warm + 1] ?? '').lifecycle;
    console.log(`warm start: ${await warmStart(config, store, files)} events from ${files.length} files`, JSON.stringify(store.stats()));
  }
  const e = config.enrichment;
  const scheduler = new MeasuredScheduler({ maxPending: e.maxPending, maxWaitSeconds: e.maxWaitMinutes * 60, requestsPerSecond: config.rest.requestsPerSecond, burst: config.rest.burst });
  const createdAt = new Map<string, number>(); // only for the age-at-dispatch measure
  scheduler.createdAt = (m) => createdAt.get(m) ?? null;
  const now = () => (store.watermark === null ? 0 : secondsValue(store.watermark));
  const enricher = new Enricher(store, scheduler, null, {
    suspectRepollSeconds: e.suspectRepollMinutes * 60, knownRefreshSeconds: e.knownRefreshMinutes * 60,
    minRefreshSeconds: config.rest.cache.devHistoryTtlSeconds, maxInflight: e.maxInflight, minTokenAgeSeconds: e.minTokenAgeSeconds,
  }, now);

  const replay = mergedReplay(capture, mints, config.stream.dedupWindowPerType);
  const samples: Record<string, unknown>[] = [];
  let start = Infinity;
  let end = 0;
  let nextSample = 0;
  let events = 0;
  for await (const ev of replay.events()) {
    store.apply(ev);
    enricher.observe(ev);
    enricher.tick();
    events += 1;
    if ('blockTime' in ev) {
      const t = secondsValue(ev.blockTime);
      if (t < start) start = t;
      if (t > end) end = t;
    }
    if (ev.type === 'token_create') createdAt.set(ev.mint, secondsValue(ev.blockTime));
    if (!memoryOnly) collect(ev, store);
    const wm = now();
    if (wm >= nextSample) {
      if (nextSample > 0) {
        gc?.();
        const m = process.memoryUsage();
        const s = store.stats();
        samples.push({
          at: new Date(wm * 1000).toISOString(), events, heapMB: Math.round(m.heapUsed / 1e6), rssMB: Math.round(m.rss / 1e6),
          tokens: s.tokens.tracked, creators: s.creators.known, readings: s.readings, pendingMints: s.pending.mints,
          evictedTokens: s.evicted.tokens, evictedCreators: s.evicted.creators, enrichment: enricher.stats(),
        });
        console.log(JSON.stringify(samples.at(-1)));
      }
      nextSample = wm - (wm % SAMPLE_EVERY_SECONDS) + SAMPLE_EVERY_SECONDS;
    }
  }
  const seconds = (Date.now() - started) / 1000;
  console.log(`${events} events in ${seconds.toFixed(0)} s; swap lines skipped by the mint prefilter: ${replay.skippedSwapLines()}; malformed`, replay.processor.malformed);
  if (memoryOnly) {
    createdAt.clear();
    gc?.();
    console.log(`final retained heap ${Math.round(process.memoryUsage().heapUsed / 1e6)} MB`, JSON.stringify(store.stats()));
  }

  const outcomes = new Map<string, TokenOutcome>();
  for (const c of store.creators.values()) for (const l of c.launches.values()) if (l.outcome !== null) outcomes.set(l.mint, l.outcome);
  for (const t of store.tokens.values()) outcomes.set(t.mint, outcomeOf(t));
  for (const [mint, o] of outcomes) {
    if (memoryOnly && !features.has(mint)) continue;
    f(mint).outcome = { stage: o.stage, peak: o.peakLiquidityUsd?.toNumber() ?? null, last: o.lastLiquidityUsd?.toNumber() ?? null, at: secondsValue(o.at) };
  }
  const creators: CaptureFeatures['creators'] = {};
  for (const c of store.creators.values()) creators[c.creator] = { launches: c.launches.size, serial: c.serial };
  const pct = (xs: number[] | undefined, p: number) => (xs === undefined || xs.length === 0 ? null : [...xs].sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))]);
  const perClass = (m: Record<string, number[]>) =>
    Object.fromEntries(Object.entries(m).map(([k, xs]) => [k, { n: xs.length, p10: pct(xs, 0.1), p50: pct(xs, 0.5), p90: pct(xs, 0.9), under10s: xs.filter((v) => v < 10).length, under60s: xs.filter((v) => v < 60).length }]));
  const out: CaptureFeatures = {
    capture: prefix, start, end, tokens: Object.fromEntries(features), creators, samples,
    enrichment: { final: enricher.stats(), waitSeconds: perClass(scheduler.waits), tokenAgeAtDispatchSeconds: perClass(scheduler.ageAtDispatch) },
    replay: { events, seconds, skippedSwapLines: replay.skippedSwapLines(), byType: replay.processor.byType, stats: store.stats() },
  };
  mkdirSync('data/calibration', { recursive: true });
  const file = `data/calibration/${prefix}${memoryOnly ? '-memory' : ''}${warm !== -1 ? '-warm' : ''}.json`;
  writeFileSync(file, JSON.stringify(out));
  console.log(`wrote ${file}`);
}

const posOf = (e: { slot: number; txIndex: number; ixIndex: number; innerIxIndex: number }) => [e.slot, e.txIndex, e.ixIndex, e.innerIxIndex];
function newer(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}
function setPool(x: TokenFeatures, e: { pool: string }, next: PoolLast): void {
  const current = x.pools[e.pool];
  if (current === undefined || newer(next.pos, current.pos)) x.pools[e.pool] = next;
}

function collect(e: SolamiEvent, store: ReturnType<typeof createStateStore>): void {
  const tracked = (m: string) => store.tokens.has(m);
  let mint: string | null;
  switch (e.type) {
    case 'token_create': {
      const x = f(e.mint);
      x.creator = e.creator;
      x.createdAt = secondsValue(e.blockTime);
      x.launchpad = e.dex;
      x.name = e.name.trim().toLowerCase();
      return;
    }
    case 'graduation': {
      const x = f(e.mint);
      x.creator ??= e.creator;
      if (x.gradAt === null || secondsValue(e.blockTime) < x.gradAt) x.gradAt = secondsValue(e.blockTime);
      x.gradDex = e.dex;
      return;
    }
    case 'liquidity': {
      mint = tracked(e.baseMint) ? e.baseMint : tracked(e.quoteMint) ? e.quoteMint : null;
      if (mint === null) return;
      const isBase = mint === e.baseMint;
      const other = isBase ? e.quoteMint : e.baseMint;
      const moved = other === SOL ? sol(isBase ? e.quoteAmount : e.baseAmount, 9) : null;
      const reserve = other === SOL ? sol(isBase ? e.quoteReserve : e.baseReserve, 9) : null;
      f(mint).liq.push([secondsValue(e.blockTime), e.kind === 'add' ? 0 : 1, e.provider, e.pool, e.dex, moved, reserve]);
      setPool(f(mint), e, {
        dex: e.dex, t: secondsValue(e.blockTime), pos: posOf(e), sol: reserve,
        base: isBase ? sol(e.baseReserve, e.baseDecimals) : sol(e.quoteReserve, e.quoteDecimals), priceUsd: f(mint).pools[e.pool]?.priceUsd ?? null,
      });
      break;
    }
    case 'swap': {
      mint = tracked(e.mint) ? e.mint : tracked(e.quoteMint) ? e.quoteMint : null;
      if (mint === null) return;
      const x = f(mint);
      const isMint = mint === e.mint;
      if (!isMint) {
        x.quoteLegSwaps += 1; // the other leg of a pair swap: counted once, from the token's side
        return;
      }
      const t = secondsValue(e.blockTime);
      const sell = e.side === 'sell' ? 1 : 0;
      const reserve = e.quoteMint === SOL ? sol(e.quoteReserve, 9) : null;
      setPool(x, e, { dex: e.dex, t, pos: posOf(e), sol: reserve, base: sol(e.baseReserve, e.baseDecimals), priceUsd: e.priceUsd.toNumber() });
      if (store.token(mint)?.stage === 'graduated') {
        let id = traderIds.get(e.trader);
        if (id === undefined) traderIds.set(e.trader, (id = traderIds.size));
        x.sw.push(t, sell, id, reserve ?? -1);
      } else {
        x.curveSwaps += 1;
        x.curveSells += sell;
      }
      break;
    }
    default:
      return;
  }
  const token = store.token(mint);
  const x = features.get(mint);
  if (token === undefined || x === undefined) return;
  // Tradable liquidity: non-curve pools of a graduated token, SOL-quoted, at the current SOL price.
  const solUsd = store.quotePrices.get(SOL)?.usdPerUnit.toNumber();
  if (token.stage === 'graduated' && solUsd !== undefined) {
    let total = 0;
    for (const p of Object.values(x.pools)) if (!CURVE_DEXES.has(p.dex) && p.sol !== null) total += p.sol * solUsd;
    x.tradableLast = total;
    if (x.tradablePeak === null || total > x.tradablePeak) x.tradablePeak = total;
    if (x.tradableCollapseAt === null && x.tradablePeak >= HAD && total <= LOW) {
      x.tradableCollapseAt = secondsValue(e.blockTime);
      x.tradableCollapseBy = e.type === 'liquidity' ? `liquidity ${e.kind}` : 'swap';
      x.tradableCollapseActor = e.type === 'liquidity' ? e.provider : e.trader;
    }
  }
  // Same collapse definition as analyze.ts / phase 3: quote-side peak ≥ $1,000, now ≤ $5.
  if (x.collapseAt !== null) return;
  const current = currentLiquidityUsd(token);
  if (token.peakLiquidityUsd !== null && token.peakLiquidityUsd.gte(HAD) && current !== null && current.lte(LOW)) {
    x.collapseAt = secondsValue(e.blockTime);
    x.collapseBy = e.type === 'liquidity' ? `liquidity ${e.kind}` : 'swap';
    x.collapseActor = e.type === 'liquidity' ? e.provider : e.trader;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
