/** Builds the phase-3 pieces from the validated config. */
import type { AppConfig } from '../config.js';
import { millisValue, secondsValue, systemClock, type Clock } from '../core/time.js';
import type { SolamiEvent } from '../events/types.js';
import { ReplaySource } from '../ingest/replay-source.js';
import { SolamiRestClient } from '../rest/client.js';
import { TokenBucket } from '../rest/token-bucket.js';
import { Enricher, type EnricherStats, type HistoryFetcher } from './enricher.js';
import { EnrichmentScheduler } from './scheduler.js';
import { StateStore, type StateStats } from './store.js';

export function createStateStore(config: AppConfig): StateStore {
  return new StateStore({ state: config.state, launchBurst: config.detection.launchBurst });
}

export function createRestClient(config: AppConfig, clock: Clock = systemClock): SolamiRestClient {
  if (config.apiKey === null) throw new Error('SOLAMI_API_KEY is required for the REST client');
  const r = config.rest;
  return new SolamiRestClient({
    baseUrl: r.baseUrl,
    apiKey: config.apiKey,
    timeoutMs: r.timeoutMs,
    devHistoryTokenLimit: r.devHistoryTokenLimit,
    cache: r.cache,
    liquidityHistory: r.liquidityHistory,
    bucket: new TokenBucket({ capacity: r.burst, refillPerSecond: r.requestsPerSecond, maxQueue: r.maxQueue }, clock),
    clock,
  });
}

/**
 * `fetcher` null = simulated enrichment on event time (the store watermark): nothing is sent,
 * the budget policy is only measured. Otherwise live, on the wall clock.
 */
export function createEnricher(
  config: AppConfig,
  store: StateStore,
  fetcher: HistoryFetcher | null,
  clock: Clock = systemClock,
): Enricher {
  const e = config.enrichment;
  const scheduler = new EnrichmentScheduler({
    maxPending: e.maxPending,
    maxWaitSeconds: e.maxWaitMinutes * 60,
    requestsPerSecond: config.rest.requestsPerSecond,
    burst: config.rest.burst,
  });
  const now =
    fetcher === null
      ? () => {
          const wm = store.watermark;
          return wm === null ? 0 : secondsValue(wm);
        }
      : () => millisValue(clock()) / 1000;
  return new Enricher(
    store,
    scheduler,
    fetcher,
    {
      suspectRepollSeconds: e.suspectRepollMinutes * 60,
      knownRefreshSeconds: e.knownRefreshMinutes * 60,
      minRefreshSeconds: config.rest.cache.devHistoryTtlSeconds,
      maxInflight: e.maxInflight,
    },
    now,
  );
}

/** Feeds one event to the memory (and the enricher, if any). */
export function applyEvent(store: StateStore, enricher: Enricher | null, event: SolamiEvent): void {
  store.apply(event);
  enricher?.observe(event);
}

/** Replays persisted lifecycle files into the store (no enrichment: those events are old). */
export async function warmStart(config: AppConfig, store: StateStore, files: readonly string[]): Promise<number> {
  const source = new ReplaySource({ paths: files, dedupWindowPerType: config.stream.dedupWindowPerType, warn: () => {} });
  let events = 0;
  for await (const event of source.events()) {
    store.apply(event);
    events += 1;
  }
  return events;
}

export interface StateHealth extends StateStats {
  readonly enrichment: EnricherStats | null;
  readonly memory: { readonly heapUsedMB: number; readonly rssMB: number };
}

export function stateHealth(store: StateStore, enricher: Enricher | null): StateHealth {
  const memory = process.memoryUsage();
  return {
    ...store.stats(),
    enrichment: enricher?.stats() ?? null,
    memory: { heapUsedMB: Math.round(memory.heapUsed / 1e6), rssMB: Math.round(memory.rss / 1e6) },
  };
}

export function summarizeState(h: StateHealth): string {
  const e = h.enrichment;
  const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
  return [
    `[state] tokens=${h.tokens.tracked} (curve ${h.tokens.curve}, graduated ${h.tokens.graduated})`,
    `creators=${h.creators.known} serial=${h.creators.serial} overThreshold=${h.creators.overThresholdNow}`,
    `launches=${h.launchesSeen} graduations=${h.graduationsSeen}`,
    e ? `rest(${e.mode}) sent=${e.sent} ok=${e.succeeded} failed=${e.failed} pending=${e.pending} discarded=${sum(e.discardedFull) + sum(e.discardedStale)}` : 'rest=off',
    `heap=${h.memory.heapUsedMB}MB`,
  ].join(' ');
}
