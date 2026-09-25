import { describe, expect, it } from 'vitest';
import { unixMillis } from '../../src/core/time.js';
import { normalizeEvent } from '../../src/events/normalize.js';
import type { SolamiEvent } from '../../src/events/types.js';
import { parseJsonLossless } from '../../src/core/json.js';
import { backoffDelay } from '../../src/ingest/backoff.js';
import { dedupKey, DedupWindow } from '../../src/ingest/dedup.js';
import { EventQueue, type Priority } from '../../src/ingest/event-queue.js';
import { asBackfill, SESSION, typeOf } from './helpers.js';

const normalize = (line: string, at = 1_790_300_000_000): SolamiEvent => {
  const result = normalizeEvent(parseJsonLossless(line), unixMillis(at));
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.event;
};
const first = (type: string) => SESSION.find((l) => typeOf(l) === type)!;

describe('backoffDelay', () => {
  const options = { initialDelayMs: 1000, maxDelayMs: 60_000, multiplier: 2 };

  it('grows exponentially and is capped', () => {
    expect([1, 2, 3, 4, 7, 20].map((n) => backoffDelay(n, options, () => 0.999999))).toEqual([
      1000, 2000, 4000, 8000, 60_000, 60_000,
    ]);
  });

  it('jitter stays within [base/2, base]: never ~0 ms, never above the cap', () => {
    for (let i = 0; i < 200; i += 1) {
      const d = backoffDelay(3, options);
      expect(d).toBeGreaterThanOrEqual(2000);
      expect(d).toBeLessThanOrEqual(4000);
    }
  });
});

describe('dedupKey', () => {
  it('is identical for an event and its backfill replay, for every type', () => {
    for (const type of ['token_create', 'pool_create', 'graduation', 'liquidity', 'transfer', 'swap', 'meme']) {
      const line = SESSION.find((l) => typeOf(l) === type && !l.includes('"backfill":true')) ?? first(type);
      const replay = normalize(asBackfill(line), 1_790_300_999_999);
      expect(dedupKey(replay), type).toBe(dedupKey(normalize(line)));
    }
  });

  it('uses signature + instruction position + mint for tx events', () => {
    const swap = normalize(first('swap')) as Extract<SolamiEvent, { type: 'swap' }>;
    expect(dedupKey(swap)).toBe(`${swap.signature}|${swap.ixIndex}|${swap.innerIxIndex}|${swap.mint}`);
    const liquidity = normalize(first('liquidity')) as Extract<SolamiEvent, { type: 'liquidity' }>;
    expect(dedupKey(liquidity)).toContain(liquidity.baseMint);
  });

  it('distinguishes meme snapshots whose content differs', () => {
    const meme = first('meme');
    const later = meme.replace(/"price_usd":"[^"]+"/, '"price_usd":"123.456"');
    expect(dedupKey(normalize(later))).not.toBe(dedupKey(normalize(meme)));
  });

  it('never deduplicates control events', () => {
    expect(dedupKey(normalize(first('connected')))).toBeNull();
    expect(dedupKey(normalize(first('backfill_end')))).toBeNull();
  });
});

describe('DedupWindow', () => {
  it('remembers the last N keys PER TYPE (swaps cannot evict launches)', () => {
    const window = new DedupWindow(2);
    const launch = normalize(first('token_create'));
    const swaps = SESSION.filter((l) => typeOf(l) === 'swap').slice(0, 10).map((l) => normalize(l));
    expect(window.isDuplicate(launch)).toBe(false);
    for (const swap of swaps) window.isDuplicate(swap);
    expect(window.isDuplicate(launch)).toBe(true);
    expect(window.isDuplicate(swaps[0]!)).toBe(false); // evicted: only the last 2 swaps are kept
  });
});

describe('EventQueue', () => {
  type Item = { id: string; p: Priority };
  const make = (capacity: number) => new EventQueue<Item>(capacity, (i) => i.p);
  const pullAll = async (q: EventQueue<Item>) => {
    q.end();
    const out: string[] = [];
    for (let r = await q.next(); !r.done; r = await q.next()) out.push(r.value.id);
    return out;
  };

  it('delivers in arrival order across priorities', async () => {
    const q = make(10);
    for (const [id, p] of [['a', 'bulk'], ['b', 'critical'], ['c', 'normal'], ['d', 'bulk']] as const) q.push({ id, p });
    expect(await pullAll(q)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('when full, evicts the oldest of the least important class', async () => {
    const q = make(3);
    q.push({ id: 'n1', p: 'normal' });
    q.push({ id: 'b1', p: 'bulk' });
    q.push({ id: 'b2', p: 'bulk' });
    expect(q.push({ id: 'c1', p: 'critical' })?.id).toBe('b1');
    expect(q.push({ id: 'n2', p: 'normal' })?.id).toBe('b2');
    expect(q.push({ id: 'n3', p: 'normal' })?.id).toBe('n1'); // same class: oldest goes
    expect(q.push({ id: 'b3', p: 'bulk' })?.id).toBe('b3'); // everything queued is more important
    expect(await pullAll(q)).toEqual(['c1', 'n2', 'n3']);
  });

  it('a waiting consumer gets the next push directly; end() releases it', async () => {
    const q = make(1);
    const waiting = q.next();
    q.push({ id: 'x', p: 'bulk' });
    expect(await waiting).toEqual({ done: false, value: { id: 'x', p: 'bulk' } });
    const pending = q.next();
    q.end();
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(q.push({ id: 'late', p: 'critical' })?.id).toBe('late');
  });

  it('stays O(1) and correct over many items', async () => {
    const q = make(5000);
    for (let i = 0; i < 20_000; i += 1) q.push({ id: String(i), p: 'bulk' });
    expect(q.length).toBe(5000);
    const out = await pullAll(q);
    expect(out[0]).toBe('15000');
    expect(out.at(-1)).toBe('19999');
  });

  it('validates capacity', () => {
    expect(() => make(0)).toThrow(RangeError);
  });
});
