import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { secondsValue, unixMillis } from '../../src/core/time.js';
import { currentLiquidityUsd } from '../../src/state/token-state.js';
import {
  event,
  graduation,
  liquidity,
  meme,
  newStore,
  poolCreate,
  realCreatorHistory,
  shuffled,
  snapshot,
  SOL,
  swap,
  T0,
  tokenCreate,
} from './helpers.js';

const usd = (value: Decimal | null | undefined) => value?.toNumber() ?? null;

/** A price for SOL ($100) must be known before reserves can be valued. */
const seedSolPrice = (t = T0 - 10) => liquidity('SEED', t, { pool: 'seed-pool', quoteReserveSol: 1, movedSol: 1, solPrice: 100 });

describe('StateStore: one token, start to end', () => {
  it('follows token_create → curve → graduation → pool → liquidity drain', () => {
    const store = newStore();
    for (const e of [
      seedSolPrice(),
      tokenCreate('M1', 'C1', T0),
      meme('M1', T0 + 10, '20.5', 17e9),
      meme('M1', T0 + 80, '99.9', 85e9), // next minute: one curve reading per minute is kept
      graduation('M1', 'C1', T0 + 90),
      poolCreate('M1', T0 + 90),
      liquidity('M1', T0 + 91, { kind: 'add', quoteReserveSol: 80, movedSol: 80 }),
      liquidity('M1', T0 + 400, { kind: 'remove', quoteReserveSol: 0.02, movedSol: 79.98 }),
    ]) {
      store.apply(e);
    }

    const token = store.token('M1');
    expect(token).toMatchObject({ creator: 'C1', stage: 'graduated', launchpad: 'pumpfun', quoteMint: SOL, graduationPool: 'amm-M1' });
    expect(secondsValue(token!.createdAt!)).toBe(T0);
    expect(secondsValue(token!.graduatedAt!)).toBe(T0 + 90);
    expect(token!.progressPct?.toString()).toBe('99.9');
    expect(usd(token!.peakLiquidityUsd)).toBe(8500); // 85 SOL on the curve
    expect(secondsValue(token!.peakAt!)).toBe(T0 + 80);
    expect(usd(currentLiquidityUsd(token!))).toBe(2); // 0.02 SOL left in the pool
    expect(token!.readings.map((r) => [r.source, usd(r.liquidityUsd)])).toEqual([
      ['curve', 1700],
      ['curve', 8500],
      ['pool', 8000],
      ['pool', 2],
    ]);
    expect(store.stats()).toMatchObject({ launchesSeen: 1, graduationsSeen: 1, tokens: { tracked: 1, graduated: 1 } });
  });

  it('counts a creator’s launches inside the 24 h window only and flags > 10 as serial', () => {
    const store = newStore();
    for (let i = 0; i < 11; i += 1) store.apply(tokenCreate(`S${i}`, 'SERIAL', T0 + i * 60));
    store.apply(tokenCreate('L1', 'LEGIT', T0));
    expect(store.launchesInWindow('SERIAL')).toBe(11);
    expect(store.creator('SERIAL')?.serial).toBe(true);
    expect(store.creator('LEGIT')?.serial).toBe(false);
    // 24 h later the old launches leave the window, but the creator stays serial (sticky).
    store.apply(tokenCreate('LATE', 'LEGIT', T0 + 24 * 3600 + 30));
    expect(store.launchesInWindow('SERIAL')).toBe(10);
    expect(store.creator('SERIAL')?.serial).toBe(true);
    expect(store.launchesInWindow('nobody')).toBe(0);
  });

  it('follows the token on either side of a pair (pool_create and swaps reversed: SOL/TOKEN)', () => {
    const store = newStore();
    store.apply(seedSolPrice());
    store.apply(tokenCreate('M2', 'C2', T0));
    store.apply(poolCreate('M2', T0 + 5, 'rev-pool', true));
    store.apply(swap('M2', T0 + 6, { pool: 'rev-pool', quoteReserveSol: 3, reversed: true }));
    const token = store.token('M2')!;
    expect(token.pools.has('rev-pool')).toBe(true);
    expect(usd(token.pools.get('rev-pool')?.latest?.liquidityUsd)).toBe(300);
  });

  it('values swaps: a drain by selling shows up although no liquidity "remove" ever happens', () => {
    const store = newStore();
    store.apply(seedSolPrice());
    store.apply(tokenCreate('M3', 'C3', T0));
    store.apply(liquidity('M3', T0 + 1, { quoteReserveSol: 90 }));
    store.apply(swap('M3', T0 + 120, { quoteReserveSol: 0.03 }));
    expect(usd(currentLiquidityUsd(store.token('M3')!))).toBe(3);
    expect(usd(store.token('M3')!.peakLiquidityUsd)).toBe(9000);
  });

  it('ignores swaps and unrelated types of tokens it does not follow (the firehose)', () => {
    const store = newStore();
    store.apply(swap('UNKNOWN', T0, { quoteReserveSol: 5 }));
    store.apply(event({ type: 'backfill_end', events: 3 }));
    expect(store.tokens.size).toBe(0);
    expect(store.stats().pending.mints).toBe(0);
  });

  it('keeps one reading per pool and minute (the last), but the peak sees every reading', () => {
    const store = newStore();
    store.apply(seedSolPrice());
    store.apply(tokenCreate('M4', 'C4', T0 - (T0 % 60)));
    const t = T0 - (T0 % 60) + 60;
    store.apply(swap('M4', t + 1, { quoteReserveSol: 10, slot: 1 }));
    store.apply(swap('M4', t + 30, { quoteReserveSol: 50, slot: 2 }));
    store.apply(swap('M4', t + 59, { quoteReserveSol: 20, slot: 3 }));
    store.apply(swap('M4', t + 61, { quoteReserveSol: 5, slot: 4 }));
    const pool = store.token('M4')!.readings.filter((r) => r.source === 'pool');
    expect(pool.map((r) => usd(r.liquidityUsd))).toEqual([2000, 500]);
    expect(usd(store.token('M4')!.peakLiquidityUsd)).toBe(5000);
  });

  it('bounds readings and pools per token', () => {
    const store = newStore({ maxReadingsPerToken: 3, maxPoolsPerToken: 2 });
    store.apply(seedSolPrice());
    store.apply(tokenCreate('M5', 'C5', T0));
    for (let i = 1; i <= 5; i += 1) store.apply(swap('M5', T0 + i * 60, { quoteReserveSol: i, slot: i, pool: `p${i}` }));
    const token = store.token('M5')!;
    expect(token.readings.map((r) => usd(r.liquidityUsd))).toEqual([300, 400, 500]);
    expect([...token.pools.keys()].sort()).toEqual(['p4', 'p5']);
    // A reading older than everything kept is not inserted, but still counts for the peak.
    store.apply(swap('M5', T0 + 30, { quoteReserveSol: 99, slot: 0, pool: 'p5' }));
    expect(token.readings.map((r) => usd(r.liquidityUsd))).toEqual([300, 400, 500]);
    expect(usd(token.peakLiquidityUsd)).toBe(9900);
  });

  it('does not value reserves before any price for the quote is known (counted)', () => {
    const store = newStore();
    store.apply(tokenCreate('M6', 'C6', T0));
    store.apply(meme('M6', T0 + 1, '5', 1e9));
    expect(store.token('M6')!.readings).toEqual([]);
    expect(store.stats().unpricedReadings).toBe(1);
  });
});

describe('StateStore: out-of-order and duplicated delivery', () => {
  it('a graduation before its token_create: stub first, completed later, stage never goes back', () => {
    const store = newStore();
    store.apply(graduation('G1', 'C1', T0 + 100));
    expect(store.token('G1')).toMatchObject({ stage: 'graduated', creator: 'C1', createdAt: null });
    expect(store.launchesInWindow('C1')).toBe(0); // creation time unknown: not counted yet

    store.apply(tokenCreate('G1', 'C1', T0));
    store.apply(meme('G1', T0 + 50, '60', 50e9)); // late curve update
    const token = store.token('G1')!;
    expect(token.stage).toBe('graduated');
    expect(secondsValue(token.createdAt!)).toBe(T0);
    expect(store.launchesInWindow('C1')).toBe(1);
  });

  it('an old liquidity reading never overwrites a newer one', () => {
    const store = newStore();
    store.apply(seedSolPrice());
    store.apply(tokenCreate('L1', 'C1', T0));
    const fresh = liquidity('L1', T0 + 600, { kind: 'remove', quoteReserveSol: 0.01, slot: 900 });
    const stale = liquidity('L1', T0 + 60, { kind: 'add', quoteReserveSol: 80, slot: 100 });
    store.apply(fresh);
    store.apply(stale);
    const token = store.token('L1')!;
    expect(usd(currentLiquidityUsd(token))).toBe(1);
    expect(token.readings.filter((r) => r.source === 'pool').map((r) => usd(r.liquidityUsd))).toEqual([8000, 1]);
    expect(usd(token.peakLiquidityUsd)).toBe(8000);
  });

  it('an old meme never rolls progress back', () => {
    const store = newStore();
    store.apply(meme('P1', T0 + 20, '80', 1e9));
    store.apply(meme('P1', T0 + 10, '30', 1e9));
    expect(store.token('P1')?.progressPct?.toString()).toBe('80');
  });

  it('liquidity that arrives before its token waits, and is applied when the token appears', () => {
    const store = newStore();
    store.apply(seedSolPrice());
    store.apply(liquidity('W1', T0 + 5, { quoteReserveSol: 40 }));
    store.apply(poolCreate('W1', T0 + 4));
    expect(store.token('W1')).toBeUndefined();
    expect(store.stats().pending.mints).toBe(2); // W1, and the untracked SEED
    store.apply(tokenCreate('W1', 'C1', T0));
    expect(usd(currentLiquidityUsd(store.token('W1')!))).toBe(4000);
    expect(store.stats().pending).toMatchObject({ mints: 1, released: 2 });
  });

  it('waiting events expire (most liquidity is about tokens we never follow)', () => {
    const store = newStore({ pending: { maxMints: 2, maxEventsPerMint: 1, ttlSeconds: 60 }, sweepEverySeconds: 1 });
    store.apply(liquidity('X1', T0, { quoteReserveSol: 1 }));
    store.apply(liquidity('X1', T0 + 1, { quoteReserveSol: 1 })); // over maxEventsPerMint
    store.apply(liquidity('X2', T0 + 2, { quoteReserveSol: 1 }));
    store.apply(liquidity('X3', T0 + 3, { quoteReserveSol: 1 })); // over maxMints: X1 dropped
    expect(store.stats().pending).toMatchObject({ mints: 2, expired: 2 });
    store.apply(tokenCreate('Y', 'C', T0 + 200)); // sweep: X2, X3 expire
    expect(store.stats().pending).toMatchObject({ mints: 0, expired: 4 });
  });

  it('applying every event twice (backfill, warm start overlap) changes nothing', () => {
    const events = lifecycleEvents();
    const once = newStore();
    const twice = newStore();
    for (const e of events) once.apply(e);
    for (const e of [...events, ...events]) twice.apply(e);
    expect(snapshot(twice)).toEqual(snapshot(once));
    expect(twice.stats().launchesSeen).toBe(once.stats().launchesSeen);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('any arrival order gives the same state (permutation seed %i)', (seed) => {
    // Guarantee holds once the quote's USD price is known (SOL: within the first second live).
    // Before that a reserve cannot be valued and the reading is skipped and counted (see above).
    const [priceSeed, ...events] = lifecycleEvents();
    const inOrder = newStore();
    const shuffledStore = newStore();
    for (const store of [inOrder, shuffledStore]) store.apply(priceSeed!);
    for (const e of events) inOrder.apply(e);
    for (const e of shuffled(events, seed)) shuffledStore.apply(e);
    expect(snapshot(shuffledStore)).toEqual(snapshot(inOrder));
  });

  it('by design, a swap that arrives before its token is dropped, not held (99% of swaps are not ours)', () => {
    const store = newStore();
    store.apply(seedSolPrice());
    store.apply(swap('EARLY', T0 + 1, { quoteReserveSol: 5 }));
    store.apply(tokenCreate('EARLY', 'C', T0));
    expect(store.token('EARLY')!.readings).toEqual([]);
    store.apply(swap('EARLY', T0 + 2, { quoteReserveSol: 4 })); // the next swap is taken
    expect(usd(currentLiquidityUsd(store.token('EARLY')!))).toBe(400);
  });

  it('counts events older than the watermark as late (and still applies them)', () => {
    const store = newStore();
    store.apply(tokenCreate('A', 'C', T0 + 1000));
    store.apply(tokenCreate('B', 'C', T0));
    expect(store.stats().lateEvents).toBe(1);
    expect(store.token('B')).toBeDefined();
  });

  it('a bogus future block time cannot push the watermark past receive time + skew', () => {
    const store = newStore();
    const received = unixMillis(T0 * 1000);
    store.apply(event({ ...rawTokenCreate('F', T0 + 86_400 * 30) }, received));
    expect(secondsValue(store.watermark!)).toBe(T0 + 60);
  });
});

/** A realistic mix for the order tests: 3 creators, stubs, pools, readings, a pending event. No swaps (see above). */
function lifecycleEvents() {
  return [
    liquidity('SEED', T0 - 100, { pool: 'seed', quoteReserveSol: 1, movedSol: 1, solPrice: 100, slot: 1 }),
    tokenCreate('A1', 'CA', T0),
    tokenCreate('A2', 'CA', T0 + 60),
    tokenCreate('B1', 'CB', T0 + 5),
    meme('A1', T0 + 10, '40', 30e9),
    meme('A1', T0 + 20, '100', 85e9),
    graduation('A1', 'CA', T0 + 21),
    poolCreate('A1', T0 + 21),
    liquidity('A1', T0 + 22, { quoteReserveSol: 80, slot: 50 }),
    liquidity('A1', T0 + 90, { kind: 'remove', quoteReserveSol: 30, slot: 60 }),
    liquidity('A1', T0 + 500, { kind: 'remove', quoteReserveSol: 0.02, slot: 70 }),
    graduation('Z9', 'CZ', T0 + 30), // token_create never seen
    liquidity('B1', T0 + 40, { pool: 'b-pool', quoteReserveSol: 12, slot: 80 }),
    meme('B1', T0 + 41, '10', 12e9),
  ];
}

function rawTokenCreate(mint: string, t: number) {
  return {
    type: 'token_create', kind: 'token', signature: 's', slot: 1, block_time: t, tx_index: 0, ix_index: 0,
    inner_ix_index: -1, indexed_at: t * 1000, dex: 'pumpfun', mint, pool: 'p', base_mint: mint,
    quote_mint: SOL, name: 'n', symbol: 's', creator: 'C',
  };
}

describe('StateStore: bounded memory', () => {
  it('evicts idle curve tokens fast and graduated ones slowly, folding them into the creator', () => {
    const store = newStore({ tokenIdleMinutes: { curve: 60, graduated: 1440 }, sweepEverySeconds: 60 });
    store.apply(seedSolPrice());
    store.apply(tokenCreate('DEAD', 'C1', T0));
    store.apply(tokenCreate('GRAD', 'C1', T0));
    store.apply(graduation('GRAD', 'C1', T0 + 10));
    store.apply(liquidity('GRAD', T0 + 11, { quoteReserveSol: 80 }));

    store.apply(tokenCreate('ACTIVE', 'C1', T0 + 23 * 3600)); // C1 keeps launching: remembered
    store.apply(tokenCreate('TICK1', 'C2', T0 + 61 * 60)); // 61 min later: DEAD expires
    expect(store.token('DEAD')).toBeUndefined();
    expect(store.token('GRAD')).toBeDefined();
    expect(store.creator('C1')?.launches.get('DEAD')?.outcome).toMatchObject({ stage: 'created' });

    store.apply(tokenCreate('TICK2', 'C2', T0 + 24 * 3600 + 120)); // > 24 h idle: GRAD expires
    expect(store.token('GRAD')).toBeUndefined();
    const outcome = store.creator('C1')?.launches.get('GRAD')?.outcome;
    expect(outcome).toMatchObject({ stage: 'graduated' });
    expect(usd(outcome?.peakLiquidityUsd)).toBe(8000);
    expect(usd(outcome?.lastLiquidityUsd)).toBe(8000);
    expect(store.stats().evicted.tokens).toBeGreaterThanOrEqual(2);
  });

  it('a stale event never resurrects an evicted token, but its launch still counts', () => {
    const store = newStore({ sweepEverySeconds: 60 });
    store.apply(tokenCreate('OLD', 'C1', T0));
    store.apply(tokenCreate('NOW', 'C2', T0 + 2 * 3600)); // OLD idle > 60 min: evicted
    expect(store.token('OLD')).toBeUndefined();
    store.apply(tokenCreate('OLD', 'C1', T0)); // replayed (backfill / warm-start overlap)
    store.apply(meme('OLD', T0 + 5, '10', 1e9));
    store.apply(tokenCreate('OLD2', 'C1', T0 + 1)); // never seen, but already too old to follow
    expect(store.token('OLD')).toBeUndefined();
    expect(store.token('OLD2')).toBeUndefined();
    expect(store.launchesInWindow('C1')).toBe(2);
    expect(store.stats().launchesSeen).toBe(3);

    // It graduates hours later: followed again, with its birth recovered from the creator.
    store.apply(graduation('OLD', 'C1', T0 + 2 * 3600 + 10));
    expect(store.token('OLD')).toMatchObject({ stage: 'graduated' });
    expect(secondsValue(store.token('OLD')!.createdAt!)).toBe(T0);
  });

  it('over maxTokens, curve tokens go before graduated ones', () => {
    const store = newStore({ maxTokens: 2, sweepEverySeconds: 1 });
    store.apply(graduation('G', 'C', T0));
    store.apply(tokenCreate('C1', 'C', T0 + 1));
    store.apply(tokenCreate('C2', 'C', T0 + 2));
    store.apply(tokenCreate('C3', 'C', T0 + 3));
    expect([...store.tokens.keys()].sort()).toEqual(['C3', 'G']);
  });

  it('a creator is kept for the whole window; a serial one much longer', () => {
    const store = newStore({ creatorRetentionHours: { default: 24, serial: 168 }, sweepEverySeconds: 60 });
    for (let i = 0; i < 11; i += 1) store.apply(tokenCreate(`S${i}`, 'SERIAL', T0 + i));
    store.apply(tokenCreate('ONE', 'ONCE', T0));
    store.apply(tokenCreate('K1', 'KEEP', T0 + 23 * 3600));
    expect(store.creator('ONCE')).toBeDefined();

    store.apply(tokenCreate('K2', 'KEEP', T0 + 25 * 3600));
    expect(store.creator('ONCE')).toBeUndefined(); // 1 launch, not seen for > 24 h
    expect(store.creator('SERIAL')?.launches.size).toBe(11); // the 48-launch operator is not forgotten
    expect(store.creator('KEEP')).toBeDefined();

    store.apply(tokenCreate('K3', 'KEEP', T0 + 169 * 3600));
    expect(store.creator('SERIAL')).toBeUndefined();
  });

  it('over maxCreators, non-serial creators go first', () => {
    const store = newStore({ maxCreators: 2, sweepEverySeconds: 1 });
    for (let i = 0; i < 11; i += 1) store.apply(tokenCreate(`S${i}`, 'SERIAL', T0));
    store.apply(tokenCreate('A', 'CA', T0 + 1));
    store.apply(tokenCreate('B', 'CB', T0 + 3));
    expect([...store.creators.keys()].sort()).toEqual(['CB', 'SERIAL']);
  });
});

describe('StateStore: dev-history merge', () => {
  it('adds the launches made before we listened, holders and Solami’s liquidity', () => {
    const store = newStore();
    const history = realCreatorHistory(1_790_294_300);
    store.apply(tokenCreate(history.tokens[1]!.mint, history.creator, secondsValue(history.tokens[1]!.createdTime)));
    store.applyCreatorHistory(history);

    const creator = store.creator(history.creator)!;
    expect(creator.rest).toMatchObject({ tokensLaunched: 63, migrated: 63 });
    expect(creator.launches.size).toBe(history.tokens.length);
    expect(creator.serial).toBe(true); // 63 launches in ~13 h
    expect(store.launchesInWindow(history.creator)).toBeGreaterThan(10);

    const tracked = store.token(history.tokens[1]!.mint)!;
    expect(tracked).toMatchObject({ stage: 'graduated', holders: history.tokens[1]!.holders });
    expect(tracked.readings.at(-1)).toMatchObject({ source: 'rest', holders: history.tokens[1]!.holders });

    const untracked = creator.launches.get(history.tokens[0]!.mint)!;
    expect(untracked).toMatchObject({ source: 'rest', outcome: { stage: 'graduated', holders: 147 } });
    expect(untracked.outcome?.restLiquidityUsd?.toFixed(2)).toBe('2.92');
    expect(store.tokens.size).toBe(1); // dev-history does not create tokens to follow
  });

  it('when the stream and dev-history disagree on a time, the earliest wins in either order', () => {
    const history = realCreatorHistory(T0);
    const t = history.tokens[0]!;
    const born = secondsValue(t.createdTime);
    const graduated = secondsValue(t.graduatedTime!);
    for (const restFirst of [true, false]) {
      const store = newStore();
      const stream = [tokenCreate(t.mint, history.creator, born + 3), graduation(t.mint, history.creator, graduated + 7)];
      if (restFirst) store.applyCreatorHistory(history);
      for (const e of stream) store.apply(e);
      if (!restFirst) store.applyCreatorHistory(history);
      const token = store.token(t.mint)!;
      expect(secondsValue(token.createdAt!)).toBe(born);
      // dev-history about a token not followed yet only lands in the creator's launch record.
      expect(secondsValue(token.graduatedAt!)).toBe(restFirst ? graduated + 7 : graduated);
      expect(store.creator(history.creator)?.launches.get(t.mint)).toMatchObject({ source: 'stream', createdAt: born });
    }
  });

  it('a REST answer is not activity: it does not keep a dead token alive', () => {
    const store = newStore();
    const history = realCreatorHistory(T0 + 2 * 3600);
    const mint = history.tokens[0]!.mint;
    store.apply(tokenCreate(mint, history.creator, T0));
    store.applyCreatorHistory(history);
    expect(secondsValue(store.token(mint)!.lastActivity)).toBe(T0);
  });
});
