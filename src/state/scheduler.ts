/**
 * WHO gets a dev-history request, and in which order, under 1 request/second.
 *
 * dev-history takes a mint but answers for the whole CREATOR, so requests are one per creator
 * (deduplicated): measured over 12.5 h there were 18,055 launches but 7,812 creators, ~15,000
 * creators/day against a budget of 86,400 requests/day. On average it fits; what the policy
 * decides is latency and what is lost in bursts (connect backfill, launch storms) and to the
 * periodic re-polls that make a liquidity collapse visible as an event in time.
 *
 * Priority, highest first:
 *   1. suspect       creator over the launch-burst threshold: re-polled every few minutes.
 *                    Holders and Solami's liquidity only come from REST; signals 2 and 3 need them.
 *   2. graduation    a graduated token is where there is real money to drain.
 *   3. new-creator   first launch of a creator we never asked about: dev-history reveals the
 *                    launches made before we started listening (fixes the cold start).
 *   4. known-creator a known, non-suspect creator launched again; asked only if the last answer
 *                    is old. Our own stream already counts this launch.
 * FIFO inside a class. A creator already waiting is upgraded, never queued twice. When full, the
 * oldest request of the lowest class is discarded; a request that waited `maxWaitSeconds` is
 * discarded when reached. Both are counted as "discarded by budget".
 *
 * Time is injected (seconds), so the same policy runs live (wall clock) and simulated over a
 * replay (event time), which is how it was measured against the 10.5 h capture.
 */
export const PRIORITIES = ['suspect', 'graduation', 'new-creator', 'known-creator'] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface EnrichmentRequest {
  readonly creator: string;
  /** Any mint of that creator: the endpoint takes a mint. */
  readonly mint: string;
  readonly priority: Priority;
  readonly enqueuedAt: number;
}

export interface SchedulerOptions {
  readonly maxPending: number;
  readonly maxWaitSeconds: number;
  readonly requestsPerSecond: number;
  readonly burst: number;
}

type ClassCounters = Record<Priority, number>;
const zero = (): ClassCounters => ({ suspect: 0, graduation: 0, 'new-creator': 0, 'known-creator': 0 });

export interface SchedulerStats {
  readonly pending: number;
  readonly dispatched: ClassCounters;
  readonly discardedFull: ClassCounters;
  readonly discardedStale: ClassCounters;
  /** Mean seconds between enqueue and dispatch, per class (null if none yet). */
  readonly meanWaitSeconds: Record<Priority, number | null>;
}

export class EnrichmentScheduler {
  private readonly queues: Record<Priority, Map<string, EnrichmentRequest>> = {
    suspect: new Map(),
    graduation: new Map(),
    'new-creator': new Map(),
    'known-creator': new Map(),
  };
  private readonly dispatched = zero();
  private readonly discardedFull = zero();
  private readonly discardedStale = zero();
  private readonly totalWait = zero();
  private tokens: number;
  private lastRefill: number | null = null;

  constructor(private readonly options: SchedulerOptions) {
    this.tokens = options.burst;
  }

  get pending(): number {
    return PRIORITIES.reduce((sum, p) => sum + this.queues[p].size, 0);
  }

  priorityOf(creator: string): Priority | undefined {
    return PRIORITIES.find((p) => this.queues[p].has(creator));
  }

  enqueue(creator: string, mint: string, priority: Priority, now: number): void {
    const current = this.priorityOf(creator);
    if (current !== undefined) {
      if (PRIORITIES.indexOf(priority) >= PRIORITIES.indexOf(current)) return;
      const existing = this.queues[current].get(creator);
      this.queues[current].delete(creator);
      this.queues[priority].set(creator, { creator, mint, priority, enqueuedAt: existing?.enqueuedAt ?? now });
      return;
    }
    this.queues[priority].set(creator, { creator, mint, priority, enqueuedAt: now });
    if (this.pending > this.options.maxPending) this.discardLowest();
  }

  /** The next request to send now, if the budget allows one. */
  take(now: number): EnrichmentRequest | null {
    this.refill(now);
    if (this.tokens < 1) return null;
    for (const priority of PRIORITIES) {
      for (const [creator, request] of this.queues[priority]) {
        this.queues[priority].delete(creator);
        const waited = now - request.enqueuedAt;
        if (waited > this.options.maxWaitSeconds) {
          this.discardedStale[priority] += 1;
          continue;
        }
        this.tokens -= 1;
        this.dispatched[priority] += 1;
        this.totalWait[priority] += waited;
        return request;
      }
    }
    return null;
  }

  stats(): SchedulerStats {
    const meanWaitSeconds = {} as Record<Priority, number | null>;
    for (const p of PRIORITIES) {
      meanWaitSeconds[p] = this.dispatched[p] === 0 ? null : Math.round(this.totalWait[p] / this.dispatched[p]);
    }
    return {
      pending: this.pending,
      dispatched: { ...this.dispatched },
      discardedFull: { ...this.discardedFull },
      discardedStale: { ...this.discardedStale },
      meanWaitSeconds,
    };
  }

  private refill(now: number): void {
    if (this.lastRefill === null) this.lastRefill = now;
    if (now <= this.lastRefill) return; // time going backwards never earns budget
    this.tokens = Math.min(this.options.burst, this.tokens + (now - this.lastRefill) * this.options.requestsPerSecond);
    this.lastRefill = now;
  }

  private discardLowest(): void {
    for (const priority of [...PRIORITIES].reverse()) {
      for (const creator of this.queues[priority].keys()) {
        this.queues[priority].delete(creator);
        this.discardedFull[priority] += 1;
        return;
      }
    }
  }
}
