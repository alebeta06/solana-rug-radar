/**
 * Normalized Solami Blur events: what the rest of the system sees.
 *
 * Conventions (enforced by src/events/schemas.ts):
 * - camelCase here, snake_case only in raw JSON: the casing tells you which side of the border you are on.
 * - Decimals are `Decimal`, raw on-chain amounts are `bigint`, counts are safe-integer `number`.
 * - Timestamps are `UnixSeconds` / `UnixMillis`, never bare numbers.
 * - Every event carries `origin` (realtime vs backfill vs catchup) and `receivedAt`.
 *
 * Shapes are typed against real captures (data/*.jsonl, 2026-09-24), not against the docs.
 * The four list snapshots had no real sample yet: they are `UnverifiedSnapshot`.
 */
import type { Decimal } from 'decimal.js';
import type { UnixMillis, UnixSeconds } from '../core/time.js';

export const STREAM_EVENT_TYPES = [
  'swap',
  'liquidity',
  'token_create',
  'pool_create',
  'transfer',
  'candle',
  'stats',
  'meme',
  'graduation',
  'surge',
  'radar',
  'metadata',
] as const;
export const CONTROL_EVENT_TYPES = ['connected', 'backfill_end'] as const;
export const SNAPSHOT_TYPES = ['launches', 'graduating', 'graduated', 'trending'] as const;

export type StreamEventType = (typeof STREAM_EVENT_TYPES)[number];
export type ControlEventType = (typeof CONTROL_EVENT_TYPES)[number];
export type SnapshotType = (typeof SNAPSHOT_TYPES)[number];
export type EventType = StreamEventType | ControlEventType | SnapshotType;

/**
 * - `realtime`: live event.
 * - `backfill`: replayed on connect (`backfill: true`), up to `backfill=N` per type.
 * - `catchup`: `metadata` resolved for a token seen earlier (`catchup: true`).
 */
export type EventOrigin = 'realtime' | 'backfill' | 'catchup';

interface EventBase {
  readonly origin: EventOrigin;
  /** Local wall-clock time when we received the frame. */
  readonly receivedAt: UnixMillis;
}

/** Position of the instruction that produced the event. */
interface TxRef {
  readonly signature: string;
  readonly slot: number;
  readonly blockTime: UnixSeconds;
  readonly txIndex: number;
  readonly ixIndex: number;
  /** -1 = top-level instruction (not an inner/CPI instruction). */
  readonly innerIxIndex: number;
  /** When Solami indexed it (millis!). */
  readonly indexedAt: UnixMillis;
}

export interface TokenCreateEvent extends EventBase, TxRef {
  readonly type: 'token_create';
  readonly dex: string;
  readonly mint: string;
  readonly pool: string;
  readonly baseMint: string;
  readonly quoteMint: string;
  readonly name: string;
  readonly symbol: string;
  /** null when absent (2 of 18,055 real launches) or "". */
  readonly uri: string | null;
  readonly creator: string;
}

export interface PoolCreateEvent extends EventBase, TxRef {
  readonly type: 'pool_create';
  readonly dex: string;
  readonly mint: string;
  readonly pool: string;
  readonly baseMint: string;
  readonly quoteMint: string;
  readonly creator: string;
}

export interface GraduationEvent extends EventBase {
  readonly type: 'graduation';
  readonly mint: string;
  readonly launchpad: string;
  readonly creator: string;
  /**
   * UNRELIABLE. In real captures it is ~763,000 s (~8.8 days) AHEAD of the token's actual
   * `token_create.block_time`, with a non-constant offset. Do not use it for timing; use the
   * `token_create` block time or dev-history `createdTime`. Renamed so it can't be used by accident.
   */
  readonly reportedCreatedTime: UnixSeconds;
  readonly pool: string;
  readonly dex: string;
  readonly slot: number;
  readonly blockTime: UnixSeconds;
}

export interface LiquidityEvent extends EventBase, TxRef {
  readonly type: 'liquidity';
  readonly dex: string;
  readonly pool: string;
  readonly kind: 'add' | 'remove';
  readonly provider: string;
  readonly baseMint: string;
  readonly quoteMint: string;
  readonly baseAmount: bigint;
  readonly quoteAmount: bigint;
  readonly baseDecimals: number;
  readonly quoteDecimals: number;
  readonly baseReserve: bigint;
  readonly quoteReserve: bigint;
  readonly baseUsd: Decimal;
  readonly quoteUsd: Decimal;
}

export interface SwapEvent extends EventBase, TxRef {
  readonly type: 'swap';
  readonly dex: string;
  readonly pool: string;
  readonly mint: string;
  readonly quoteMint: string;
  readonly trader: string;
  readonly side: 'buy' | 'sell';
  readonly baseAmount: bigint;
  readonly quoteAmount: bigint;
  readonly baseDecimals: number;
  readonly quoteDecimals: number;
  readonly baseReserve: bigint;
  readonly quoteReserve: bigint;
  readonly feeAmount: bigint;
  readonly feeMint: string;
  readonly feePct: Decimal;
  readonly feePaidOut: bigint;
  readonly priceImpactPct: Decimal;
  /** Price in quote token units. */
  readonly price: Decimal;
  readonly priceUsd: Decimal;
  readonly volumeUsd: Decimal;
  /** Missing in ~1% of real swaps. */
  readonly mcapUsd: Decimal | null;
  readonly candleOk: boolean;
  readonly virtualBaseReserve: bigint;
  readonly virtualQuoteReserve: bigint;
}

export interface TransferEvent extends EventBase, TxRef {
  readonly type: 'transfer';
  /** All three kinds observed in real captures (2026-09-24). */
  readonly kind: 'transfer' | 'mint' | 'burn';
  readonly mint: string;
  /** Always null for `mint` (tokens come from nowhere). */
  readonly srcOwner: string | null;
  /** Always null for `burn`; also null on ~3% of `transfer` (cause not yet known). */
  readonly dstOwner: string | null;
  readonly amount: bigint;
  readonly decimals: number | null;
}

export interface CandleEvent extends EventBase {
  readonly type: 'candle';
  readonly mint: string;
  readonly pool: string;
  /** Only "1m" observed. */
  readonly interval: string;
  /** Start of the candle bucket (raw field `time`). */
  readonly openTime: UnixSeconds;
  readonly open: Decimal;
  readonly high: Decimal;
  readonly low: Decimal;
  readonly close: Decimal;
  readonly volume: Decimal;
  readonly trades: number;
  /** false while the bucket is still open and may be updated. */
  readonly closed: boolean;
}

/** One rolling window of `stats`/`meme` (raw `windows` is keyed by seconds: "300", "3600"). */
export interface TradeWindow {
  readonly windowSeconds: number;
  readonly volumeUsd: Decimal;
  readonly trades: number;
  readonly buys: number;
  readonly sells: number;
  readonly priceChangePct: Decimal;
}

export interface StatsEvent extends EventBase {
  readonly type: 'stats';
  readonly mint: string;
  readonly priceUsd: Decimal;
  readonly blockTime: UnixSeconds;
  readonly windows: readonly TradeWindow[];
}

export interface MemeMetadata {
  readonly name: string | null;
  readonly symbol: string | null;
  readonly uri: string | null;
  readonly creator: string | null;
  readonly logoUri: string | null;
  readonly description: string | null;
  readonly socials: Readonly<Record<string, string | null>>;
  readonly decimals: number | null;
  readonly supply: bigint | null;
}

export interface MemeEvent extends EventBase {
  readonly type: 'meme';
  readonly mint: string;
  readonly launchpad: string;
  /** null until Solami's metadata resolver fills it. Does NOT mean the token doesn't exist. */
  readonly metadata: MemeMetadata | null;
  readonly creator: string | null;
  /** UNRELIABLE, same offset as GraduationEvent.reportedCreatedTime. */
  readonly reportedCreatedTime: UnixSeconds | null;
  readonly graduated: boolean;
  readonly progressPct: Decimal;
  readonly priceUsd: Decimal;
  readonly baseReserve: bigint;
  readonly quoteReserve: bigint;
  readonly blockTime: UnixSeconds;
  readonly windows: readonly TradeWindow[];
}

/** Shared by `surge` and `radar` (identical shape in real captures). */
interface SpikeFields {
  readonly mint: string;
  readonly triggerTime: UnixSeconds;
  readonly mcapAtTrigger: Decimal;
  readonly priceAtTrigger: Decimal;
  readonly volumeWindowUsd: Decimal;
  readonly baselineUsd: Decimal;
  readonly multiple: Decimal;
  readonly trades: number;
  readonly tradersEst: number;
  readonly windowSeconds: number;
}

export interface SurgeEvent extends EventBase, SpikeFields {
  readonly type: 'surge';
}

export interface RadarEvent extends EventBase, SpikeFields {
  readonly type: 'radar';
}

export interface MetadataEvent extends EventBase {
  readonly type: 'metadata';
  readonly mint: string;
  readonly name: string | null;
  readonly symbol: string | null;
  readonly decimals: number;
  readonly uri: string | null;
  /** Solami image proxy URL with our `api_key` REMOVED (the raw one embeds it). */
  readonly imageUrl: string | null;
  readonly logoUri: string | null;
  readonly description: string | null;
  readonly socials: Readonly<Record<string, string | null>>;
  /** null when Solami sends its i64::MAX "no timestamp" sentinel. */
  readonly resolvedAt: UnixMillis | null;
}

export interface ConnectedEvent extends EventBase {
  readonly type: 'connected';
  readonly region: string;
  readonly subscribedTypes: readonly string[];
}

export interface BackfillEndEvent extends EventBase {
  readonly type: 'backfill_end';
  /** Number of backfilled events sent before this marker. */
  readonly events: number;
}

/**
 * List snapshots (sent on connect, recomputed every 30 s). NOT VERIFIED against a real
 * capture yet, so only `type` is trusted and the payload is kept as `raw` (typed `unknown`:
 * it must be validated before use, which also keeps its numeric strings quarantined).
 */
export interface UnverifiedSnapshot extends EventBase {
  readonly type: SnapshotType;
  readonly verified: false;
  readonly raw: Readonly<Record<string, unknown>>;
}

export type StreamEvent =
  | SwapEvent
  | LiquidityEvent
  | TokenCreateEvent
  | PoolCreateEvent
  | TransferEvent
  | CandleEvent
  | StatsEvent
  | MemeEvent
  | GraduationEvent
  | SurgeEvent
  | RadarEvent
  | MetadataEvent;

export type ControlEvent = ConnectedEvent | BackfillEndEvent;

export type SolamiEvent = StreamEvent | ControlEvent | UnverifiedSnapshot;
