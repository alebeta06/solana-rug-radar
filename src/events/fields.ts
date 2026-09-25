/** Raw field groups shared by several event schemas (see ./schemas.ts). */
import { z } from 'zod';
import { decimalString, millisField, safeInt, secondsField } from '../core/schema.js';
import type { EventOrigin, SolamiEvent, TradeWindow } from './types.js';

/** What a schema produces: the event minus `receivedAt`, which the normalizer stamps. */
export type EventBody<T extends SolamiEvent> = Omit<T, 'receivedAt'>;

export const originFields = {
  backfill: z.boolean().optional(),
  catchup: z.boolean().optional(),
};

export function originOf(raw: { backfill?: boolean | undefined; catchup?: boolean | undefined }): EventOrigin {
  if (raw.catchup === true) return 'catchup';
  if (raw.backfill === true) return 'backfill';
  return 'realtime';
}

export const txRefFields = {
  signature: z.string(),
  slot: safeInt,
  block_time: secondsField,
  tx_index: safeInt,
  ix_index: safeInt,
  inner_ix_index: safeInt,
  indexed_at: millisField,
};
type TxRefRaw = z.output<z.ZodObject<typeof txRefFields>>;

export function txRef(raw: TxRefRaw) {
  return {
    signature: raw.signature,
    slot: raw.slot,
    blockTime: raw.block_time,
    txIndex: raw.tx_index,
    ixIndex: raw.ix_index,
    innerIxIndex: raw.inner_ix_index,
    indexedAt: raw.indexed_at,
  };
}

export const socials = z.record(z.string(), z.string().nullable());

export const windows = z
  .record(
    z.string().regex(/^\d+$/, 'window key must be a number of seconds'),
    z.object({
      volume_usd: decimalString,
      trades: safeInt,
      buys: safeInt,
      sells: safeInt,
      price_change_pct: decimalString,
    }),
  )
  .transform((byKey): TradeWindow[] =>
    Object.entries(byKey)
      .map(([seconds, w]) => ({
        windowSeconds: Number(seconds),
        volumeUsd: w.volume_usd,
        trades: w.trades,
        buys: w.buys,
        sells: w.sells,
        priceChangePct: w.price_change_pct,
      }))
      .sort((a, b) => a.windowSeconds - b.windowSeconds),
  );

export const spikeFields = {
  ...originFields,
  mint: z.string(),
  trigger_time: secondsField,
  mcap_at_trigger: decimalString,
  price_at_trigger: decimalString,
  volume_window_usd: decimalString,
  baseline_usd: decimalString,
  multiple: decimalString,
  trades: safeInt,
  traders_est: safeInt,
  window_secs: safeInt,
};
type SpikeRaw = z.output<z.ZodObject<typeof spikeFields>>;

export function spike(r: SpikeRaw) {
  return {
    origin: originOf(r),
    mint: r.mint,
    triggerTime: r.trigger_time,
    mcapAtTrigger: r.mcap_at_trigger,
    priceAtTrigger: r.price_at_trigger,
    volumeWindowUsd: r.volume_window_usd,
    baselineUsd: r.baseline_usd,
    multiple: r.multiple,
    trades: r.trades,
    tradersEst: r.traders_est,
    windowSeconds: r.window_secs,
  };
}

