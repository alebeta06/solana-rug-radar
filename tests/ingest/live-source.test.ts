import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { millisValue } from '../../src/core/time.js';
import type { SolamiEvent } from '../../src/events/types.js';
import { LiveSource, type LiveSourceOptions } from '../../src/ingest/live-source.js';
import type { RawPersister } from '../../src/ingest/raw-persister.js';
import { asBackfill, collect, FAKE_TIMERS, fakeServer, isBackfill, SESSION, settle, typeOf } from './helpers.js';

const CRITICAL = new Set(['token_create', 'pool_create', 'graduation', 'connected', 'backfill_end']);

function setup(overrides: Partial<LiveSourceOptions> = {}) {
  const server = fakeServer();
  const warnings: string[] = [];
  const source = new LiveSource({
    url: 'wss://ws.solami.dev/data/subscribe',
    chain: 'solana',
    types: ['token_create', 'pool_create', 'graduation', 'liquidity', 'transfer', 'swap', 'meme'],
    backfill: 200,
    apiKey: 'sk_test_secret',
    dedupWindowPerType: 1000,
    staleAfterMs: 30_000,
    reconnect: { initialDelayMs: 1000, maxDelayMs: 60_000, multiplier: 2, resetAfterMs: 30_000 },
    queueCapacity: 50_000,
    priorityOf: (type) => (CRITICAL.has(type) ? 'critical' : type === 'liquidity' || type === 'meme' ? 'normal' : 'bulk'),
    persister: null,
    createSocket: server.createSocket,
    random: () => 0, // lower bound of the jitter: delays are exactly base/2
    warn: (message) => warnings.push(message),
    ...overrides,
  });
  return { source, server, warnings };
}

const types = (events: readonly SolamiEvent[]) => events.map((e) => e.type);

describe('LiveSource', () => {
  beforeEach(() => vi.useFakeTimers(FAKE_TIMERS));
  afterEach(() => vi.useRealTimers());

  it('subscribes with the configured types, chain and backfill', () => {
    const { source, server } = setup();
    source.events();
    const url = new URL(server.last.url);
    expect(url.origin + url.pathname).toBe('wss://ws.solami.dev/data/subscribe');
    expect(url.searchParams.get('type')).toBe('token_create,pool_create,graduation,liquidity,transfer,swap,meme');
    expect(url.searchParams.get('backfill')).toBe('200');
    expect(url.searchParams.get('chain')).toBe('solana');
    expect(url.searchParams.get('api_key')).toBe('sk_test_secret');
  });

  it('goes connecting → backfilling → live on backfill_end, delivering normalized events', async () => {
    const { source, server } = setup();
    const consumer = collect(source.events());
    expect(source.health().state).toBe('connecting');
    server.last.open();
    expect(source.health().state).toBe('backfilling');

    const endOfBackfill = SESSION.findIndex((l) => typeOf(l) === 'backfill_end');
    server.last.send(...SESSION.slice(0, endOfBackfill));
    expect(source.health().state).toBe('backfilling');
    server.last.send(...SESSION.slice(endOfBackfill));
    expect(source.health().state).toBe('live');
    await settle();

    expect(consumer.items).toHaveLength(SESSION.length);
    expect(consumer.items.filter((e) => e.origin === 'backfill')).toHaveLength(SESSION.filter(isBackfill).length);
    expect(source.health().byType.token_create?.delivered).toBe(SESSION.filter((l) => typeOf(l) === 'token_create').length);
  });

  it('keeps both sides of a two-sided swap (same signature+ix+inner_ix, different mint)', async () => {
    const { source, server } = setup();
    const consumer = collect(source.events());
    server.last.open();
    // This transaction has 6 events in the sample; two are swaps from the SAME instruction.
    const pair = SESSION.filter(
      (l) =>
        typeOf(l) === 'swap' &&
        l.includes('"signature":"53HaXH77uzuCed9VvYZieLmVWnZ7') &&
        l.includes('"ix_index":3,"inner_ix_index":4,'),
    );
    expect(pair).toHaveLength(2);
    server.last.send(...pair);
    await settle();
    expect(consumer.items).toHaveLength(2);
    expect(source.health().byType.swap?.duplicates).toBe(0);
  });

  describe('malformed frames never stop ingestion', () => {
    it('drops and counts them, keeps delivering valid frames, logs each kind once, redacts keys', async () => {
      const { source, server, warnings } = setup();
      const consumer = collect(source.events());
      server.last.open();
      const valid = SESSION.find((l) => typeOf(l) === 'token_create')!;
      const badShape = valid.replace(/"slot":\d+/, '"slot":"not-a-number"');
      server.last.send(
        '{ not json',
        '[1,2,3]',
        '{"type":"rugpull_now"}',
        badShape,
        badShape,
        '{"type":"metadata","mint":"M","image_url":"https://api.solami.dev/i?api_key=sk_test_secret"}',
        valid,
      );
      await settle();

      expect(types(consumer.items)).toEqual(['token_create']);
      expect(source.health().malformed).toMatchObject({ invalidJson: 1, notAnObject: 1, unknownType: 1, invalidShape: 3 });
      expect(warnings).toHaveLength(5); // the repeated bad token_create is logged once
      expect(JSON.stringify(source.health())).not.toContain('sk_test_secret');
      expect(warnings.join()).not.toContain('sk_test_secret');
    });
  });

  describe('reconnection', () => {
    it('reconnects after a drop, with exponential backoff (not in a tight loop)', async () => {
      const { source, server } = setup();
      source.events();
      server.last.open();
      server.last.drop();
      expect(source.health().state).toBe('reconnecting');
      expect(source.health().connection?.lastError).toContain('code 1006');

      // Server keeps refusing: 1st retry after 500 ms, then 1000, 2000, 4000 (random=0 → base/2)
      const gaps: number[] = [];
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const before = server.sockets.length;
        const start = Date.now();
        while (server.sockets.length === before) await vi.advanceTimersByTimeAsync(10);
        gaps.push(Date.now() - start);
        server.last.drop(); // refused again
      }
      expect(gaps).toEqual([500, 1000, 2000, 4000]);
      expect(source.health().connection?.consecutiveFailures).toBe(5);
    });

    it('caps the wait at maxDelayMs', async () => {
      const { source, server } = setup({
        reconnect: { initialDelayMs: 1000, maxDelayMs: 3000, multiplier: 10, resetAfterMs: 30_000 },
      });
      source.events();
      const waits: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        server.last.drop();
        waits.push(millisValue(source.health().connection!.nextRetryAt!) - Date.now());
        await vi.advanceTimersByTimeAsync(3000);
      }
      // base: 1000, 10000→3000, 3000… ; random=0 → half of it
      expect(waits).toEqual([500, 1500, 1500, 1500, 1500]);
    });

    it('resets the backoff only after a connection stayed up for resetAfterMs', async () => {
      const { source, server } = setup();
      source.events();
      server.last.drop();
      await vi.advanceTimersByTimeAsync(500);
      server.last.drop();
      await vi.advanceTimersByTimeAsync(1000);
      expect(source.health().connection?.consecutiveFailures).toBe(2);

      server.last.open();
      await vi.advanceTimersByTimeAsync(29_000);
      server.last.send(SESSION[0]!); // keep it non-stale
      await vi.advanceTimersByTimeAsync(1_000);
      server.last.drop(); // lived 30 s: counts as a fresh failure
      expect(source.health().connection?.consecutiveFailures).toBe(1);
    });

    it('treats a silent connection as dead (stale watchdog)', async () => {
      const { source, server } = setup({ staleAfterMs: 10_000 });
      source.events();
      const first = server.last;
      first.open();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(first.closedByClient).toBe(true);
      expect(source.health().connection?.lastError).toMatch(/^stale/);

      // A late close from the dead socket must not schedule a second reconnect.
      expect(first.onclose).toBeNull();
      await vi.advanceTimersByTimeAsync(500);
      expect(server.sockets).toHaveLength(2);
    });
  });

  describe('deduplication between backfill and realtime', () => {
    it('after a reconnect, backfill replays of delivered events are skipped; new ones are delivered', async () => {
      const { source, server } = setup();
      const consumer = collect(source.events());
      const realtime = SESSION.filter((l) => !isBackfill(l) && !['connected', 'backfill_end'].includes(typeOf(l)));
      server.last.open();
      server.last.send(...realtime.slice(0, 100));
      await settle();
      expect(consumer.items).toHaveLength(100);

      server.last.drop();
      await vi.advanceTimersByTimeAsync(500);
      server.last.open();
      // The server replays the last 60 we already have, plus 20 we missed while disconnected…
      server.last.send(...realtime.slice(40, 120).map(asBackfill), '{"type":"backfill_end","events":80}');
      // …then live resumes.
      server.last.send(...realtime.slice(120));
      await settle();

      const delivered = consumer.items.filter((e) => e.type !== 'backfill_end');
      expect(delivered).toHaveLength(realtime.length); // every event exactly once
      const duplicates = Object.values(source.health().byType).reduce((n, c) => n + c.duplicates, 0);
      expect(duplicates).toBe(60);
    });
  });

  describe('backpressure (slow consumer)', () => {
    it('never grows past capacity; drops bulk first, keeps critical, delivers in arrival order', async () => {
      const { source, server } = setup({ queueCapacity: 20 });
      const iterator = source.events(); // consumer is NOT pulling
      server.last.open();
      const launches = SESSION.filter((l) => typeOf(l) === 'token_create' && !isBackfill(l)).slice(0, 10);
      const swaps = SESSION.filter((l) => typeOf(l) === 'swap').slice(0, 25);
      // Interleaved like the real stream (a launch among swaps): L S S L S S … then the rest.
      const frames: string[] = [];
      swaps.forEach((swap, i) => {
        if (i % 2 === 0 && launches[i / 2] !== undefined) frames.push(launches[i / 2]!);
        frames.push(swap);
      });
      expect(frames.filter((f) => typeOf(f) === 'token_create')).toHaveLength(10);
      server.last.send(...frames);

      const health = source.health();
      expect(health.queue).toEqual({ length: 20, capacity: 20 });
      expect(health.byType.token_create).toMatchObject({ received: 10, dropped: 0 });
      expect(health.byType.swap).toMatchObject({ received: 25, dropped: 15 });

      // Survivors: all 10 launches + the 10 NEWEST swaps, still in arrival order.
      const newestSwaps = new Set(swaps.slice(-10));
      const expected = frames.filter((f) => typeOf(f) === 'token_create' || newestSwaps.has(f));
      const idOf = (e: SolamiEvent) => `${e.type}|${(e as { signature: string }).signature}|${(e as { mint: string }).mint}`;
      const rawId = (line: string) => {
        const r = JSON.parse(line) as { type: string; signature: string; mint: string };
        return `${r.type}|${r.signature}|${r.mint}`;
      };
      const pulled: SolamiEvent[] = [];
      for (let i = 0; i < 20; i += 1) pulled.push((await iterator.next()).value as SolamiEvent);
      expect(pulled.map(idOf)).toEqual(expected.map(rawId));
    });

    it('drops the incoming event when everything queued is more important', () => {
      const { source, server } = setup({ queueCapacity: 3 });
      source.events();
      server.last.open();
      const launches = SESSION.filter((l) => typeOf(l) === 'token_create').slice(0, 3);
      server.last.send(...launches, SESSION.find((l) => typeOf(l) === 'swap')!);
      expect(source.health().byType.swap).toMatchObject({ received: 1, dropped: 1 });
      expect(source.health().byType.token_create?.dropped).toBe(0);
    });
  });

  describe('clean shutdown', () => {
    it('closes the socket, stops reconnecting, ends the stream and flushes the persister', async () => {
      const closePersister = vi.fn(() => Promise.resolve());
      const persister = { write: vi.fn(), close: closePersister, health: vi.fn() } as unknown as RawPersister;
      const { source, server } = setup({ persister });
      const consumer = collect(source.events());
      server.last.open();
      server.last.send(SESSION[0]!);
      server.last.drop(); // a reconnect is pending…
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      await source.close(); // …and must be cancelled
      // No pending timer may keep the process alive after Ctrl+C (retry timer, stale watchdog).
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(120_000);
      await consumer.done;
      expect(server.sockets).toHaveLength(1);
      expect(source.health().state).toBe('closed');
      expect(closePersister).toHaveBeenCalledOnce();
      await source.close(); // idempotent
      expect(closePersister).toHaveBeenCalledOnce();
    });

    it('persists every raw frame, including malformed ones, tagged with its type', () => {
      const write = vi.fn();
      const persister = { write, close: vi.fn(), health: vi.fn() } as unknown as RawPersister;
      const { source, server } = setup({ persister });
      source.events();
      server.last.open();
      server.last.send(SESSION[0]!, '{ not json');
      expect(write.mock.calls).toEqual([
        ['connected', SESSION[0]],
        [null, '{ not json'],
      ]);
    });
  });
});
