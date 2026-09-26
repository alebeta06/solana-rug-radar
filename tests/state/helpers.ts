/**
 * Event factories for the state tests. They build RAW frames (the shapes captured from the real
 * stream, snake_case, decimals as strings) and run them through the real normalization border,
 * so the store is tested against exactly what ingestion delivers.
 */
import { readFileSync } from 'node:fs';
import { parseConfig, type AppConfig } from '../../src/config.js';
import { parseJsonLossless } from '../../src/core/json.js';
import { unixMillis } from '../../src/core/time.js';
import { normalizeEvent } from '../../src/events/normalize.js';
import type { SolamiEvent } from '../../src/events/types.js';
import { devHistorySchema } from '../../src/rest/schemas.js';
import type { CreatorHistory } from '../../src/rest/types.js';
import { StateStore } from '../../src/state/store.js';

export const SOL = 'So11111111111111111111111111111111111111112';
export const T0 = 1_790_300_000; // seconds, 2026-09-25
/** Far enough ahead that the watermark's future-skew cap never interferes, unless a test wants it. */
const RECEIVED_AT = unixMillis((T0 + 10 * 86_400) * 1000);

type Raw = Record<string, unknown>;

export function event(raw: Raw, receivedAt = RECEIVED_AT): SolamiEvent {
  const result = normalizeEvent(raw, receivedAt);
  if (!result.ok) throw new Error(`bad test frame: ${JSON.stringify(result.error)}`);
  return result.event;
}

let seq = 0;
function tx(t: number, slot = t * 3, ix = 0): Raw {
  seq += 1;
  return {
    signature: `sig${seq}`,
    slot,
    block_time: t,
    tx_index: seq % 1000,
    ix_index: ix,
    inner_ix_index: -1,
    indexed_at: t * 1000 + 500,
  };
}

export function tokenCreate(mint: string, creator: string, t: number, extra: Raw = {}): SolamiEvent {
  return event({
    ...tx(t),
    type: 'token_create',
    kind: 'token',
    dex: 'pumpfun',
    mint,
    pool: `curve-${mint}`,
    base_mint: mint,
    quote_mint: SOL,
    name: `Name ${mint}`,
    symbol: 'SYM',
    uri: 'https://x',
    creator,
    ...extra,
  });
}

export function meme(mint: string, t: number, progress: string, quoteReserveLamports: number, extra: Raw = {}): SolamiEvent {
  return event({
    type: 'meme',
    mint,
    launchpad: 'pumpfun',
    metadata: null,
    graduated: false,
    progress_pct: progress,
    price_usd: '0.00001',
    base_reserve: 1_000_000_000,
    quote_reserve: quoteReserveLamports,
    block_time: t,
    windows: {},
    ...extra,
  });
}

export function graduation(mint: string, creator: string, t: number, pool = `amm-${mint}`): SolamiEvent {
  return event({
    type: 'graduation',
    mint,
    launchpad: 'pumpfun',
    creator,
    created_time: t + 763_000, // the real feed's unreliable offset
    pool,
    dex: 'pumpswap',
    slot: t * 3,
    block_time: t,
  });
}

export function poolCreate(mint: string, t: number, pool = `amm-${mint}`, reversed = false): SolamiEvent {
  return event({
    ...tx(t),
    type: 'pool_create',
    kind: 'pool',
    dex: 'pumpswap',
    mint: reversed ? SOL : mint,
    pool,
    base_mint: reversed ? SOL : mint,
    quote_mint: reversed ? mint : SOL,
    creator: 'pool-creator',
  });
}

/** `quoteReserveSol` after the event; `solPrice` fixes the USD value of the moved amount. */
export function liquidity(
  mint: string,
  t: number,
  opts: { pool?: string; kind?: 'add' | 'remove'; quoteReserveSol: number; movedSol?: number; solPrice?: number; slot?: number; ix?: number },
): SolamiEvent {
  const moved = opts.movedSol ?? 1;
  const price = opts.solPrice ?? 100;
  return event({
    ...tx(t, opts.slot, opts.ix),
    type: 'liquidity',
    dex: 'pumpswap',
    pool: opts.pool ?? `amm-${mint}`,
    kind: opts.kind ?? 'add',
    provider: 'lp',
    base_mint: mint,
    quote_mint: SOL,
    base_amount: 1000,
    quote_amount: Math.round(moved * 1e9),
    base_decimals: 6,
    quote_decimals: 9,
    base_reserve: 1_000_000_000,
    quote_reserve: Math.round(opts.quoteReserveSol * 1e9),
    base_usd: '1',
    quote_usd: String(moved * price),
  });
}

export function swap(mint: string, t: number, opts: { pool?: string; quoteReserveSol: number; slot?: number; reversed?: boolean }): SolamiEvent {
  const reserve = Math.round(opts.quoteReserveSol * 1e9);
  const sides = opts.reversed
    ? { mint: SOL, quote_mint: mint, base_reserve: reserve, quote_reserve: 5_000_000, base_amount: 1e8, quote_amount: 5000, base_decimals: 9, quote_decimals: 6 }
    : { mint, quote_mint: SOL, base_reserve: 5_000_000, quote_reserve: reserve, base_amount: 5000, quote_amount: 1e8, base_decimals: 6, quote_decimals: 9 };
  return event({
    ...tx(t, opts.slot),
    type: 'swap',
    dex: 'pumpswap',
    pool: opts.pool ?? `amm-${mint}`,
    trader: 'trader',
    side: 'sell',
    ...sides,
    fee_amount: 0,
    fee_mint: SOL,
    fee_pct: '0',
    fee_paid_out: 0,
    price_impact_pct: '0',
    price: '1',
    price_usd: '1',
    volume_usd: '10',
    candle_ok: true,
    virtual_base_reserve: 0,
    virtual_quote_reserve: 0,
  });
}

const CONFIG_JSON = JSON.parse(readFileSync('config/config.json', 'utf8')) as Record<string, unknown>;

export function testConfig(state: Partial<AppConfig['state']> = {}): AppConfig {
  const base = parseConfig(CONFIG_JSON, {});
  return { ...base, state: { ...base.state, ...state } };
}

export function newStore(state: Partial<AppConfig['state']> = {}): StateStore {
  const config = testConfig(state);
  return new StateStore({ state: config.state, launchBurst: config.detection.launchBurst });
}

/** The real dev-history answer (tests/fixtures/rest-dev.json): 63 graduated tokens drained to $1–5. */
export function realCreatorHistory(fetchedAtSeconds = T0): CreatorHistory {
  const raw = parseJsonLossless(readFileSync(new URL('../fixtures/rest-dev.json', import.meta.url), 'utf8'));
  const parsed = devHistorySchema(unixMillis(fetchedAtSeconds * 1000)).parse(raw);
  return parsed.history;
}

/** A deterministic shuffle (the tests must be reproducible). */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** Everything observable in the store, as plain JSON (Decimals and bigints as strings). */
export function snapshot(store: StateStore): unknown {
  const plain = (value: unknown) =>
    JSON.parse(
      JSON.stringify(value, (_k, v: unknown) =>
        v instanceof Map ? Object.fromEntries([...(v as Map<string, unknown>)].sort(([a], [b]) => a.localeCompare(b))) : typeof v === 'bigint' ? `${v}n` : v,
      ),
    ) as unknown;
  const tokens = [...store.tokens.values()].sort((a, b) => a.mint.localeCompare(b.mint));
  const creators = [...store.creators.values()].sort((a, b) => a.creator.localeCompare(b.creator));
  // lastActivity/firstSeen/lastSeen are "max/min of event times": order-independent too.
  return plain({ watermark: store.watermark, tokens, creators });
}
