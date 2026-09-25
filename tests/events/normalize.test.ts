import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseJsonLossless } from '../../src/core/json.js';
import { Decimal } from '../../src/core/schema.js';
import { millisValue, secondsValue, unixMillis } from '../../src/core/time.js';
import { normalizeEvent } from '../../src/events/normalize.js';
import {
  CONTROL_EVENT_TYPES,
  STREAM_EVENT_TYPES,
  type SolamiEvent,
} from '../../src/events/types.js';

/** Real frames from data/*.jsonl (one or more per type + edge cases), api key replaced. */
const FIXTURE_LINES = readFileSync(new URL('../fixtures/events.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '');

const RECEIVED_AT = unixMillis(1790300000000);

type Raw = Record<string, unknown>;

const frames = FIXTURE_LINES.map((line) => {
  const raw = parseJsonLossless(line) as Raw;
  const result = normalizeEvent(raw, RECEIVED_AT);
  if (!result.ok) throw new Error(`fixture failed: ${JSON.stringify(result.error)}\n${line}`);
  return { raw, event: result.event };
});

function frame<T extends SolamiEvent['type']>(type: T, pred: (raw: Raw) => boolean = () => true) {
  const found = frames.find((f) => f.raw.type === type && pred(f.raw));
  if (found === undefined) throw new Error(`no fixture for ${type}`);
  return { raw: found.raw, event: found.event as Extract<SolamiEvent, { type: T }> };
}

function normalize(raw: unknown) {
  return normalizeEvent(raw, RECEIVED_AT);
}

const NUMERIC_STRING = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;
/** Free-text fields where a numeric-looking value is legitimate (a token can be called "420"). */
const FREE_TEXT_KEYS = new Set(['name', 'symbol', 'description', 'interval']);

function numericStrings(value: unknown, path: string, found: string[]): string[] {
  if (typeof value === 'string' && NUMERIC_STRING.test(value)) found.push(path);
  if (value !== null && typeof value === 'object' && !(value instanceof Decimal)) {
    for (const [key, child] of Object.entries(value)) {
      if (!FREE_TEXT_KEYS.has(key)) numericStrings(child, `${path}.${key}`, found);
    }
  }
  return found;
}

describe('normalizeEvent on real captured frames', () => {
  it('covers every stream and control type', () => {
    const seen = new Set(frames.map((f) => f.event.type));
    for (const type of [...STREAM_EVENT_TYPES, ...CONTROL_EVENT_TYPES]) expect(seen).toContain(type);
  });

  it('lets no numeric string cross the border', () => {
    for (const { event } of frames) expect(numericStrings(event, event.type, [])).toEqual([]);
  });

  it('stamps receivedAt on every event', () => {
    for (const { event } of frames) expect(event.receivedAt).toBe(RECEIVED_AT);
  });

  it('token_create: branded times, camelCase, origin', () => {
    const { raw, event } = frame('token_create', (r) => r.backfill === true);
    expect(event.origin).toBe('backfill');
    expect(secondsValue(event.blockTime)).toBe(raw.block_time);
    expect(millisValue(event.indexedAt)).toBe(raw.indexed_at);
    expect(event.creator).toBe(raw.creator);
    expect(event.baseMint).toBe(raw.base_mint);
    expect(frame('token_create', (r) => r.backfill === undefined).event.origin).toBe('realtime');
  });

  it('swap: reserves above 2^53 stay exact', () => {
    const { event } = frame('swap', (r) => typeof r.base_reserve === 'bigint');
    expect(event.baseReserve).toBe(16103776596248955n);
  });

  it('swap: decimals become Decimal with every digit; missing mcap is null', () => {
    const { raw, event } = frame('swap');
    expect(event.priceUsd).toBeInstanceOf(Decimal);
    expect(event.priceUsd.toString()).toBe(new Decimal(raw.price_usd as string).toString());
    expect(typeof event.baseAmount).toBe('bigint');
    expect(frame('swap', (r) => r.mcap_usd === undefined).event.mcapUsd).toBeNull();
  });

  it('graduation: unreliable created_time is renamed, not trusted', () => {
    const { raw, event } = frame('graduation');
    expect(secondsValue(event.reportedCreatedTime)).toBe(raw.created_time);
    expect(event).not.toHaveProperty('createdTime');
  });

  it('liquidity: add/remove with bigint amounts and Decimal USD', () => {
    const { event } = frame('liquidity');
    expect(['add', 'remove']).toContain(event.kind);
    expect(typeof event.baseReserve).toBe('bigint');
    expect(event.quoteUsd).toBeInstanceOf(Decimal);
  });

  it('transfer: burn has no destination, mint has no source (real samples)', () => {
    const burn = frame('transfer', (r) => r.kind === 'burn').event;
    expect(burn).toMatchObject({ kind: 'burn', dstOwner: null });
    expect(burn.srcOwner).toBeTypeOf('string');
    const minted = frame('transfer', (r) => r.kind === 'mint').event;
    expect(minted).toMatchObject({ kind: 'mint', srcOwner: null });
    expect(minted.dstOwner).toBeTypeOf('string');
  });

  it('swap: trader and side are kept (detector: creator selling own token)', () => {
    const { raw, event } = frame('swap');
    expect(event.trader).toBe(raw.trader);
    expect(['buy', 'sell']).toContain(event.side);
  });

  it('transfer: missing owners/decimals become null', () => {
    expect(frame('transfer', (r) => r.dst_owner === undefined).event.dstOwner).toBeNull();
    expect(frame('transfer', (r) => r.decimals === undefined).event.decimals).toBeNull();
  });

  it('candle: raw `time` becomes openTime in seconds', () => {
    const { raw, event } = frame('candle');
    expect(secondsValue(event.openTime)).toBe(raw.time);
    expect(event.close).toBeInstanceOf(Decimal);
  });

  it('stats/meme: windows keyed by seconds become a sorted list', () => {
    for (const type of ['stats', 'meme'] as const) {
      const windows = frame(type).event.windows;
      expect(windows.map((w) => w.windowSeconds)).toEqual([300, 3600]);
      expect(windows[0]?.volumeUsd).toBeInstanceOf(Decimal);
    }
  });

  it('meme: nested metadata normalized, missing creator is null', () => {
    const { event } = frame('meme', (r) => r.creator !== undefined);
    expect(event.metadata?.socials).toBeTypeOf('object');
    expect(frame('meme', (r) => r.creator === undefined).event.creator).toBeNull();
  });

  it('meme: null metadata (not resolved yet) is accepted', () => {
    const { raw } = frame('meme');
    const result = normalize({ ...raw, metadata: null });
    expect(result.ok && result.event.type === 'meme' && result.event.metadata).toBeNull();
  });

  it('surge/radar: same shape, window in seconds', () => {
    for (const type of ['surge', 'radar'] as const) {
      const { raw, event } = frame(type);
      expect(event.windowSeconds).toBe(raw.window_secs);
      expect(event.multiple).toBeInstanceOf(Decimal);
    }
  });

  it('metadata: i64::MAX sentinel → null, api_key stripped from image_url, catchup origin', () => {
    const sentinel = frame('metadata', (r) => typeof r.resolved_at === 'bigint').event;
    expect(sentinel.resolvedAt).toBeNull();
    expect(sentinel.origin).toBe('catchup');
    const withImage = frame('metadata', (r) => typeof r.image_url === 'string').event;
    expect(withImage.imageUrl).not.toContain('api_key');
    expect(withImage.imageUrl).toMatch(/^https:\/\/api\.solami\.dev\/data\/token\/image\//);
  });

  it('control events', () => {
    expect(frame('connected').event.subscribedTypes.length).toBeGreaterThan(0);
    expect(frame('backfill_end').event.events).toBeGreaterThan(0);
  });
});

describe('normalizeEvent rejections (never throws)', () => {
  const tokenCreate = frame('token_create').raw;

  it.each([null, 42, 'x', []])('not an object: %s', (value) => {
    const result = normalize(value);
    expect(result).toEqual({ ok: false, error: { reason: 'not_an_object', type: null, issues: [] } });
  });

  it('unknown or missing type', () => {
    const unknown = normalize({ type: 'rug' });
    expect(!unknown.ok && unknown.error).toMatchObject({ reason: 'unknown_type', type: 'rug' });
    const missing = normalize({});
    expect(!missing.ok && missing.error).toMatchObject({ reason: 'unknown_type', type: null });
    const inherited = normalize({ type: 'toString' });
    expect(!inherited.ok && inherited.error.reason).toBe('unknown_type');
  });

  const liquidity = frame('liquidity').raw;

  it.each<[string, Raw, string]>([
    ['slot sent as string', { ...tokenCreate, slot: '450165443' }, 'slot'],
    ['decimal sent as number', { ...liquidity, base_usd: 116.42 }, 'base_usd'],
    ['millis in a seconds field', { ...tokenCreate, block_time: 1790289332000 }, 'block_time'],
    ['seconds in a millis field', { ...tokenCreate, indexed_at: 1790289333 }, 'indexed_at'],
    ['required field missing', { ...tokenCreate, creator: undefined }, 'creator'],
    ['unexpected enum value', { ...liquidity, kind: 'migrate' }, 'kind'],
  ])('invalid shape: %s', (_label, raw, field) => {
    const result = normalize(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('invalid_shape');
      expect(result.error.issues.join(' ')).toContain(field);
    }
  });
});

describe('snapshots (no real sample yet)', () => {
  it('pass through as unverified with the payload quarantined in raw', () => {
    const result = normalize({ type: 'trending', backfill: true, items: [{ mint: 'M', liquidity_usd: '3' }] });
    expect(result.ok).toBe(true);
    if (result.ok && result.event.type === 'trending') {
      expect(result.event).toMatchObject({ verified: false, origin: 'backfill' });
      expect(result.event.raw.items).toEqual([{ mint: 'M', liquidity_usd: '3' }]);
    }
  });
});
