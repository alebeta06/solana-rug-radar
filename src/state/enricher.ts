/**
 * Turns state changes into dev-history requests (policy in ./scheduler.ts) and merges the
 * answers back into the store.
 *
 * Two modes, same policy:
 * - live: `fetcher` is the rate-limited REST client; `tick()` runs on a wall-clock timer.
 * - simulated (`fetcher` = null): nothing is sent; requests are only counted, on event time.
 *   Used for replays (no API key) to measure the budget policy against real traffic.
 */
import { unixSeconds, secondsValue } from '../core/time.js';
import type { SolamiEvent } from '../events/types.js';
import type { CreatorHistory } from '../rest/types.js';
import type { EnrichmentRequest, EnrichmentScheduler, Priority, SchedulerStats } from './scheduler.js';
import type { StateStore } from './store.js';
import type { CreatorState } from './types.js';

export interface HistoryFetcher {
  getCreatorHistory(mint: string): Promise<CreatorHistory>;
}

export interface EnricherOptions {
  readonly suspectRepollSeconds: number;
  readonly knownRefreshSeconds: number;
  /** Below this, a graduation does not re-ask (the REST client caches dev-history this long anyway). */
  readonly minRefreshSeconds: number;
  readonly maxInflight: number;
}

export interface EnricherStats extends SchedulerStats {
  readonly mode: 'live' | 'simulated';
  readonly sent: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly lastError: string | null;
}

const SUSPECT_SWEEP_SECONDS = 30;

export class Enricher {
  private sent = 0;
  private succeeded = 0;
  private failed = 0;
  private lastError: string | null = null;
  private inflight = 0;
  private lastSuspectSweep: number | null = null;

  constructor(
    private readonly store: StateStore,
    private readonly scheduler: EnrichmentScheduler,
    private readonly fetcher: HistoryFetcher | null,
    private readonly options: EnricherOptions,
    /** Seconds. Wall clock live; the store watermark when simulated. */
    private readonly now: () => number,
  ) {}

  /** Call after `store.apply(event)`. */
  observe(event: SolamiEvent): void {
    if (event.type === 'token_create') {
      const creator = this.store.creator(event.creator);
      if (creator === undefined) return;
      if (creator.serial) this.request(creator, event.mint, 'suspect', this.options.suspectRepollSeconds);
      else if (creator.restRequestedAt === null) this.request(creator, event.mint, 'new-creator', 0);
      else this.request(creator, event.mint, 'known-creator', this.options.knownRefreshSeconds);
    } else if (event.type === 'graduation') {
      const creator = this.store.creator(event.creator);
      if (creator !== undefined) this.request(creator, event.mint, 'graduation', this.options.minRefreshSeconds);
    }
  }

  /**
   * Dispatches what the budget allows now. Live: call on a timer. Simulated: call after each
   * event (the real stream carries ~9 lifecycle events/s, so the 1 req/s budget is sampled
   * finely enough; a long gap between events only under-uses it, never over-uses it).
   */
  tick(): void {
    const now = this.now();
    this.sweepSuspects(now);
    const maxInflight = this.fetcher === null ? Infinity : this.options.maxInflight;
    while (this.inflight < maxInflight) {
      const request = this.scheduler.take(now);
      if (request === null) break;
      this.dispatch(request, now);
    }
  }

  stats(): EnricherStats {
    return {
      mode: this.fetcher === null ? 'simulated' : 'live',
      sent: this.sent,
      succeeded: this.succeeded,
      failed: this.failed,
      lastError: this.lastError,
      ...this.scheduler.stats(),
    };
  }

  private request(creator: CreatorState, mint: string, priority: Priority, minAgeSeconds: number): void {
    const now = this.now();
    const last = creator.restRequestedAt;
    if (last !== null && now - secondsValue(last) < minAgeSeconds) return;
    this.scheduler.enqueue(creator.creator, mint, priority, now);
  }

  /** Suspects are re-asked periodically even if they stop launching: the drain comes later. */
  private sweepSuspects(now: number): void {
    if (this.lastSuspectSweep !== null && now - this.lastSuspectSweep < SUSPECT_SWEEP_SECONDS) return;
    this.lastSuspectSweep = now;
    for (const creator of this.store.creators.values()) {
      if (!creator.serial) continue;
      const mint = latestMint(creator);
      if (mint !== null) this.request(creator, mint, 'suspect', this.options.suspectRepollSeconds);
    }
  }

  private dispatch(request: EnrichmentRequest, now: number): void {
    const creator = this.store.creator(request.creator);
    if (creator !== undefined) creator.restRequestedAt = unixSeconds(Math.floor(now));
    this.sent += 1;
    if (this.fetcher === null) return;
    this.inflight += 1;
    this.fetcher
      .getCreatorHistory(request.mint)
      .then((history) => {
        this.store.applyCreatorHistory(history);
        this.succeeded += 1;
      })
      .catch((error: unknown) => {
        this.failed += 1;
        this.lastError = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        this.inflight -= 1;
      });
  }
}

function latestMint(creator: CreatorState): string | null {
  let best: { mint: string; at: number } | null = null;
  for (const launch of creator.launches.values()) {
    const at = launch.createdAt === null ? -1 : secondsValue(launch.createdAt);
    if (best === null || at > best.at) best = { mint: launch.mint, at };
  }
  return best?.mint ?? null;
}
