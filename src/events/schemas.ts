/**
 * Raw → normalized schemas, one per event type. Each schema both VALIDATES the raw JSON
 * (snake_case, numeric strings, bare timestamps) and TRANSFORMS it into the normalized type
 * from ./types.ts. Unknown extra fields are dropped, so Solami adding a field never breaks us;
 * a field changing type or disappearing is a loud validation error.
 */
import { z } from 'zod';
import {
  decimalString,
  millisOrSentinelAsNull,
  optionalText,
  rawAmount,
  redactApiKey,
  safeInt,
  secondsField,
} from '../core/schema.js';
import {
  originFields,
  originOf,
  socials,
  spike,
  spikeFields,
  txRef,
  txRefFields,
  windows,
  type EventBody,
} from './fields.js';
import type {
  BackfillEndEvent,
  CandleEvent,
  ConnectedEvent,
  EventType,
  GraduationEvent,
  LiquidityEvent,
  MemeEvent,
  MetadataEvent,
  PoolCreateEvent,
  RadarEvent,
  SnapshotType,
  SolamiEvent,
  StatsEvent,
  SurgeEvent,
  SwapEvent,
  TokenCreateEvent,
  TransferEvent,
  UnverifiedSnapshot,
} from './types.js';

const tokenCreate = z
  .object({
    ...originFields,
    ...txRefFields,
    type: z.literal('token_create'),
    kind: z.literal('token'),
    dex: z.string(),
    mint: z.string(),
    pool: z.string(),
    base_mint: z.string(),
    quote_mint: z.string(),
    name: z.string(),
    symbol: z.string(),
    // Missing in 2 of 18,055 real token_create (10.5 h capture, 2026-09-25). Rejecting the
    // whole event for it would hide a launch from the detector.
    uri: optionalText,
    creator: z.string(),
  })
  .transform(
    (r): EventBody<TokenCreateEvent> => ({
      type: r.type,
      origin: originOf(r),
      ...txRef(r),
      dex: r.dex,
      mint: r.mint,
      pool: r.pool,
      baseMint: r.base_mint,
      quoteMint: r.quote_mint,
      name: r.name,
      symbol: r.symbol,
      uri: r.uri,
      creator: r.creator,
    }),
  );

const poolCreate = z
  .object({
    ...originFields,
    ...txRefFields,
    type: z.literal('pool_create'),
    kind: z.literal('pool'),
    dex: z.string(),
    mint: z.string(),
    pool: z.string(),
    base_mint: z.string(),
    quote_mint: z.string(),
    creator: z.string(),
  })
  .transform(
    (r): EventBody<PoolCreateEvent> => ({
      type: r.type,
      origin: originOf(r),
      ...txRef(r),
      dex: r.dex,
      mint: r.mint,
      pool: r.pool,
      baseMint: r.base_mint,
      quoteMint: r.quote_mint,
      creator: r.creator,
    }),
  );

const graduation = z
  .object({
    ...originFields,
    type: z.literal('graduation'),
    mint: z.string(),
    launchpad: z.string(),
    creator: z.string(),
    created_time: secondsField,
    pool: z.string(),
    dex: z.string(),
    slot: safeInt,
    block_time: secondsField,
  })
  .transform(
    (r): EventBody<GraduationEvent> => ({
      type: r.type,
      origin: originOf(r),
      mint: r.mint,
      launchpad: r.launchpad,
      creator: r.creator,
      reportedCreatedTime: r.created_time,
      pool: r.pool,
      dex: r.dex,
      slot: r.slot,
      blockTime: r.block_time,
    }),
  );

const liquidity = z
  .object({
    ...originFields,
    ...txRefFields,
    type: z.literal('liquidity'),
    dex: z.string(),
    pool: z.string(),
    kind: z.enum(['add', 'remove']),
    provider: z.string(),
    base_mint: z.string(),
    quote_mint: z.string(),
    base_amount: rawAmount,
    quote_amount: rawAmount,
    base_decimals: safeInt,
    quote_decimals: safeInt,
    base_reserve: rawAmount,
    quote_reserve: rawAmount,
    base_usd: decimalString,
    quote_usd: decimalString,
  })
  .transform(
    (r): EventBody<LiquidityEvent> => ({
      type: r.type,
      origin: originOf(r),
      ...txRef(r),
      dex: r.dex,
      pool: r.pool,
      kind: r.kind,
      provider: r.provider,
      baseMint: r.base_mint,
      quoteMint: r.quote_mint,
      baseAmount: r.base_amount,
      quoteAmount: r.quote_amount,
      baseDecimals: r.base_decimals,
      quoteDecimals: r.quote_decimals,
      baseReserve: r.base_reserve,
      quoteReserve: r.quote_reserve,
      baseUsd: r.base_usd,
      quoteUsd: r.quote_usd,
    }),
  );

const swap = z
  .object({
    ...originFields,
    ...txRefFields,
    type: z.literal('swap'),
    dex: z.string(),
    pool: z.string(),
    mint: z.string(),
    quote_mint: z.string(),
    trader: z.string(),
    side: z.enum(['buy', 'sell']),
    base_amount: rawAmount,
    quote_amount: rawAmount,
    base_decimals: safeInt,
    quote_decimals: safeInt,
    base_reserve: rawAmount,
    quote_reserve: rawAmount,
    fee_amount: rawAmount,
    fee_mint: z.string(),
    fee_pct: decimalString,
    fee_paid_out: rawAmount,
    price_impact_pct: decimalString,
    price: decimalString,
    price_usd: decimalString,
    volume_usd: decimalString,
    mcap_usd: decimalString.optional(),
    candle_ok: z.boolean(),
    virtual_base_reserve: rawAmount,
    virtual_quote_reserve: rawAmount,
  })
  .transform(
    (r): EventBody<SwapEvent> => ({
      type: r.type,
      origin: originOf(r),
      ...txRef(r),
      dex: r.dex,
      pool: r.pool,
      mint: r.mint,
      quoteMint: r.quote_mint,
      trader: r.trader,
      side: r.side,
      baseAmount: r.base_amount,
      quoteAmount: r.quote_amount,
      baseDecimals: r.base_decimals,
      quoteDecimals: r.quote_decimals,
      baseReserve: r.base_reserve,
      quoteReserve: r.quote_reserve,
      feeAmount: r.fee_amount,
      feeMint: r.fee_mint,
      feePct: r.fee_pct,
      feePaidOut: r.fee_paid_out,
      priceImpactPct: r.price_impact_pct,
      price: r.price,
      priceUsd: r.price_usd,
      volumeUsd: r.volume_usd,
      mcapUsd: r.mcap_usd ?? null,
      candleOk: r.candle_ok,
      virtualBaseReserve: r.virtual_base_reserve,
      virtualQuoteReserve: r.virtual_quote_reserve,
    }),
  );

const transfer = z
  .object({
    ...originFields,
    ...txRefFields,
    type: z.literal('transfer'),
    kind: z.enum(['transfer', 'mint', 'burn']),
    mint: z.string(),
    src_owner: z.string().optional(),
    dst_owner: z.string().optional(),
    amount: rawAmount,
    decimals: safeInt.optional(),
  })
  .transform(
    (r): EventBody<TransferEvent> => ({
      type: r.type,
      origin: originOf(r),
      ...txRef(r),
      kind: r.kind,
      mint: r.mint,
      srcOwner: r.src_owner ?? null,
      dstOwner: r.dst_owner ?? null,
      amount: r.amount,
      decimals: r.decimals ?? null,
    }),
  );

const candle = z
  .object({
    ...originFields,
    type: z.literal('candle'),
    mint: z.string(),
    pool: z.string(),
    interval: z.string(),
    time: secondsField,
    open: decimalString,
    high: decimalString,
    low: decimalString,
    close: decimalString,
    volume: decimalString,
    trades: safeInt,
    closed: z.boolean(),
  })
  .transform(
    (r): EventBody<CandleEvent> => ({
      type: r.type,
      origin: originOf(r),
      mint: r.mint,
      pool: r.pool,
      interval: r.interval,
      openTime: r.time,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
      trades: r.trades,
      closed: r.closed,
    }),
  );

const stats = z
  .object({
    ...originFields,
    type: z.literal('stats'),
    mint: z.string(),
    price_usd: decimalString,
    block_time: secondsField,
    windows,
  })
  .transform(
    (r): EventBody<StatsEvent> => ({
      type: r.type,
      origin: originOf(r),
      mint: r.mint,
      priceUsd: r.price_usd,
      blockTime: r.block_time,
      windows: r.windows,
    }),
  );

const memeMetadata = z
  .object({
    name: optionalText,
    symbol: optionalText,
    uri: optionalText,
    creator: optionalText,
    logo_uri: optionalText,
    description: optionalText,
    socials: socials.optional(),
    decimals: safeInt.nullish(),
    supply: rawAmount.nullish(),
  })
  .nullable()
  .transform((m) =>
    m === null
      ? null
      : {
          name: m.name,
          symbol: m.symbol,
          uri: m.uri,
          creator: m.creator,
          logoUri: m.logo_uri,
          description: m.description,
          socials: m.socials ?? {},
          decimals: m.decimals ?? null,
          supply: m.supply ?? null,
        },
  );

const meme = z
  .object({
    ...originFields,
    type: z.literal('meme'),
    mint: z.string(),
    launchpad: z.string(),
    metadata: memeMetadata,
    creator: z.string().optional(),
    created_time: secondsField.optional(),
    graduated: z.boolean(),
    progress_pct: decimalString,
    price_usd: decimalString,
    base_reserve: rawAmount,
    quote_reserve: rawAmount,
    block_time: secondsField,
    windows,
  })
  .transform(
    (r): EventBody<MemeEvent> => ({
      type: r.type,
      origin: originOf(r),
      mint: r.mint,
      launchpad: r.launchpad,
      metadata: r.metadata,
      creator: r.creator ?? null,
      reportedCreatedTime: r.created_time ?? null,
      graduated: r.graduated,
      progressPct: r.progress_pct,
      priceUsd: r.price_usd,
      baseReserve: r.base_reserve,
      quoteReserve: r.quote_reserve,
      blockTime: r.block_time,
      windows: r.windows,
    }),
  );

const surge = z
  .object({ ...spikeFields, type: z.literal('surge') })
  .transform((r): EventBody<SurgeEvent> => ({ type: r.type, ...spike(r) }));

const radar = z
  .object({ ...spikeFields, type: z.literal('radar') })
  .transform((r): EventBody<RadarEvent> => ({ type: r.type, ...spike(r) }));

const metadata = z
  .object({
    ...originFields,
    type: z.literal('metadata'),
    mint: z.string(),
    name: optionalText,
    symbol: optionalText,
    decimals: safeInt,
    uri: optionalText,
    image_url: optionalText,
    logo_uri: optionalText,
    description: optionalText,
    socials: socials.optional(),
    resolved_at: millisOrSentinelAsNull,
  })
  .transform(
    (r): EventBody<MetadataEvent> => ({
      type: r.type,
      origin: originOf(r),
      mint: r.mint,
      name: r.name,
      symbol: r.symbol,
      decimals: r.decimals,
      uri: r.uri,
      imageUrl: r.image_url === null ? null : redactApiKey(r.image_url),
      logoUri: r.logo_uri,
      description: r.description,
      socials: r.socials ?? {},
      resolvedAt: r.resolved_at,
    }),
  );

const connected = z
  .object({
    ...originFields,
    type: z.literal('connected'),
    region: z.string(),
    filter: z.object({ types: z.array(z.string()) }),
  })
  .transform(
    (r): EventBody<ConnectedEvent> => ({
      type: r.type,
      origin: originOf(r),
      region: r.region,
      subscribedTypes: r.filter.types,
    }),
  );

const backfillEnd = z
  .object({ ...originFields, type: z.literal('backfill_end'), events: safeInt })
  .transform(
    (r): EventBody<BackfillEndEvent> => ({ type: r.type, origin: originOf(r), events: r.events }),
  );

function snapshot<T extends SnapshotType>(type: T) {
  return z
    .looseObject({ ...originFields, type: z.literal(type) })
    .transform(
      (r): EventBody<UnverifiedSnapshot> => ({
        type: r.type,
        verified: false,
        origin: originOf(r),
        raw: r,
      }),
    );
}

type EventOf<K extends EventType> = K extends SnapshotType
  ? UnverifiedSnapshot
  : Extract<SolamiEvent, { type: K }>;

export const EVENT_SCHEMAS = {
  swap,
  liquidity,
  token_create: tokenCreate,
  pool_create: poolCreate,
  transfer,
  candle,
  stats,
  meme,
  graduation,
  surge,
  radar,
  metadata,
  connected,
  backfill_end: backfillEnd,
  launches: snapshot('launches'),
  graduating: snapshot('graduating'),
  graduated: snapshot('graduated'),
  trending: snapshot('trending'),
} satisfies { [K in EventType]: z.ZodType<EventBody<EventOf<K>>> };
