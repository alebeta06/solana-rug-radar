/**
 * Solami Data API REST client (`https://api.solami.dev/data/...`, header `x-api-key`).
 *
 * Designed around the free plan's 1 request/second:
 * - every network request waits for a TokenBucket slot;
 * - three cache tiers, TTLs from config:
 *     identity  (mint → creator, createdTime, …)  permanent  — immutable facts
 *     security  (by mint)                          long TTL   — authorities change rarely, one way
 *     history   (dev-history, BY CREATOR)          short TTL  — liquidity/holders change by the minute
 * - concurrent calls for the same key share one request;
 * - the cache is re-checked after waiting in the queue, and the slot refunded on a hit.
 */
import type { z } from 'zod';
import { formatIssues } from '../core/schema.js';
import { parseJsonLossless } from '../core/json.js';
import { systemClock, type Clock } from '../core/time.js';
import { LiquidityHistory, type LiquidityHistoryOptions } from './liquidity-history.js';
import { devHistorySchema, securitySchema } from './schemas.js';
import type { TokenBucket } from './token-bucket.js';
import { TtlLruCache } from './ttl-lru-cache.js';
import type { CreatorHistory, TokenIdentity, TokenSecurity } from './types.js';

export interface RestCacheOptions {
  readonly identityMaxEntries: number;
  readonly securityTtlSeconds: number;
  readonly securityMaxEntries: number;
  readonly devHistoryTtlSeconds: number;
  readonly devHistoryMaxEntries: number;
}

export interface RestClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly cache: RestCacheOptions;
  readonly liquidityHistory: LiquidityHistoryOptions;
  readonly bucket: TokenBucket;
  readonly fetch?: typeof fetch;
  readonly clock?: Clock;
}

export class RestError extends Error {
  constructor(
    message: string,
    readonly endpoint: string,
    /** HTTP status, or null for network/timeout/shape errors. */
    readonly status: number | null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RestError';
  }
}

const SECURITY_PATH = '/data/token/security';
const DEV_HISTORY_PATH = '/data/token/dev-history';

export class SolamiRestClient {
  readonly liquidity: LiquidityHistory;
  private readonly identities: TtlLruCache<string, TokenIdentity>;
  private readonly security: TtlLruCache<string, TokenSecurity>;
  private readonly histories: TtlLruCache<string, CreatorHistory>;
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly fetchFn: typeof fetch;
  private readonly clock: Clock;

  constructor(private readonly options: RestClientOptions) {
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.clock = options.clock ?? systemClock;
    const { cache } = options;
    this.identities = new TtlLruCache(
      { maxEntries: cache.identityMaxEntries, ttlMs: Infinity },
      this.clock,
    );
    this.security = new TtlLruCache(
      { maxEntries: cache.securityMaxEntries, ttlMs: cache.securityTtlSeconds * 1000 },
      this.clock,
    );
    this.histories = new TtlLruCache(
      { maxEntries: cache.devHistoryMaxEntries, ttlMs: cache.devHistoryTtlSeconds * 1000 },
      this.clock,
    );
    this.liquidity = new LiquidityHistory(options.liquidityHistory, this.clock);
  }

  /** Cached identity, if any request has revealed it. Never hits the network. */
  getIdentity(mint: string): TokenIdentity | undefined {
    return this.identities.get(mint);
  }

  getSecurity(mint: string): Promise<TokenSecurity> {
    return this.fetchOnce(
      `security:${mint}`,
      () => this.security.get(mint),
      async () => {
        const raw = await this.request(SECURITY_PATH, mint);
        const security = this.parse(SECURITY_PATH, securitySchema(this.clock()), raw);
        this.security.set(mint, security);
        return security;
      },
    );
  }

  /** Full launch history of the creator of `mint`. */
  getCreatorHistory(mint: string): Promise<CreatorHistory> {
    return this.fetchOnce(
      `dev-history:${mint}`,
      () => this.cachedHistoryFor(mint),
      async () => {
        const raw = await this.request(DEV_HISTORY_PATH, mint);
        const { queried, history } = this.parse(
          DEV_HISTORY_PATH,
          devHistorySchema(this.clock()),
          raw,
        );
        this.remember(queried, history);
        return history;
      },
    );
  }

  private cachedHistoryFor(mint: string): CreatorHistory | undefined {
    const identity = this.identities.get(mint);
    return identity === undefined ? undefined : this.histories.get(identity.creator);
  }

  private remember(queried: TokenIdentity, history: CreatorHistory): void {
    this.histories.set(history.creator, history);
    for (const token of history.tokens) {
      if (token.mint !== queried.mint && this.identities.get(token.mint) === undefined) {
        this.identities.set(token.mint, {
          mint: token.mint,
          creator: history.creator,
          createdTime: token.createdTime,
          launchpad: null,
          name: token.name,
          symbol: token.symbol,
        });
      }
      this.liquidity.record(token.mint, {
        observedAt: history.fetchedAt,
        liquidityUsd: token.liquidityUsd,
        holders: token.holders,
      });
    }
    this.identities.set(queried.mint, queried);
  }

  private fetchOnce<T>(key: string, lookup: () => T | undefined, load: () => Promise<T>): Promise<T> {
    const hit = lookup();
    if (hit !== undefined) return Promise.resolve(hit);
    const pending = this.inflight.get(key);
    if (pending !== undefined) return pending as Promise<T>;

    const promise = (async () => {
      await this.options.bucket.acquire();
      const lateHit = lookup();
      if (lateHit !== undefined) {
        this.options.bucket.refund();
        return lateHit;
      }
      return load();
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  private async request(path: string, mint: string): Promise<unknown> {
    const url = new URL(path, this.options.baseUrl);
    url.searchParams.set('mint', mint);
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        headers: { 'x-api-key': this.options.apiKey, accept: 'application/json' },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (cause) {
      throw new RestError(`request failed: ${String(cause)}`, path, null, { cause });
    }
    if (!response.ok) {
      throw new RestError(`HTTP ${response.status}`, path, response.status);
    }
    const text = await response.text();
    try {
      return parseJsonLossless(text);
    } catch (cause) {
      throw new RestError('response is not valid JSON', path, null, { cause });
    }
  }

  private parse<T>(path: string, schema: z.ZodType<T>, raw: unknown): T {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new RestError(`unexpected response shape: ${formatIssues(parsed.error).join('; ')}`, path, null);
    }
    return parsed.data;
  }
}
