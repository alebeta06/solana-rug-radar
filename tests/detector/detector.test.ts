import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SolamiEvent } from '../../src/events/types.js';
import { createDetector } from '../../src/detector/factory.js';
import { Registry } from '../../src/detector/registry.js';
import type { Alert, DetectorRecord, RugRecord } from '../../src/detector/types.js';
import { currentLiquidityUsd } from '../../src/state/token-state.js';
import { event, graduation, liquidity, newStore, swap, T0, testConfig, tokenCreate } from '../state/helpers.js';

const poolCreateRaw = (mint: string, t: number) => ({
  type: 'pool_create', kind: 'pool', signature: `pc-${mint}`, slot: t * 3, block_time: t, tx_index: 1, ix_index: 0, inner_ix_index: -1,
  indexed_at: t * 1000, dex: 'pumpswap', mint, pool: `amm-${mint}`, base_mint: mint, quote_mint: 'So11111111111111111111111111111111111111112', creator: 'pool-creator',
});

/** The real wiring: store → listener → detector → sink. */
function setup(preload: DetectorRecord[] = []) {
  const store = newStore();
  const records: DetectorRecord[] = [];
  const detector = createDetector(testConfig(), store, (r) => records.push(r));
  detector.load(preload);
  store.listen(detector);
  const feed = (...events: SolamiEvent[]) => events.forEach((e) => store.apply(e));
  const alerts = (level?: string) => records.filter((r): r is Alert => r.kind === 'alert' && (level === undefined || r.level === level));
  const rugs = () => records.filter((r): r is RugRecord => r.kind === 'rug');
  return { store, detector, records, feed, alerts, rugs };
}

/** SOL at $100 in these fixtures: 10 SOL = $1,000 (the confirmed-rug peak), 0.05 SOL = $5 (the floor). */
const creatorAdds = (mint: string, creator: string, t: number, sol = 84.99) =>
  liquidity(mint, t, { provider: creator, movedSol: sol, quoteReserveSol: sol });

describe('Detector: RED — the creator adds liquidity to its own token', () => {
  it('fires on a liquidity add whose provider is the creator, with the 85-SOL fingerprint and its own precision', () => {
    const { feed, alerts } = setup();
    feed(tokenCreate('A', 'CRE', T0), creatorAdds('A', 'CRE', T0 + 5));
    const [red] = alerts('red');
    expect(alerts()).toHaveLength(1);
    expect(red).toMatchObject({
      level: 'red',
      rule: 'creator-adds-liquidity',
      mint: 'A',
      creator: 'CRE',
      at: T0 + 5,
      trigger: { type: 'liquidity', pool: 'amm-A', dex: 'pumpswap' },
      evidence: { quoteAmount: '84.99', fingerprint: true },
      url: 'https://solscan.io/token/A',
    });
    expect(red!.trigger.signature).toMatch(/^sig/);
    expect(red!.confidence).toMatchObject({ confirmed: 422, fired: 431 });
    expect(red!.confidence.precision).toBeCloseTo(0.979, 3);
  });

  it('does not fire for anyone else adding liquidity, nor for the creator removing', () => {
    const { feed, alerts } = setup();
    feed(tokenCreate('A', 'CRE', T0), liquidity('A', T0 + 5, { provider: 'someone', quoteReserveSol: 85 }));
    feed(liquidity('A', T0 + 6, { provider: 'CRE', kind: 'remove', quoteReserveSol: 0 }));
    expect(alerts()).toEqual([]);
  });

  it('never fires twice for the same token (replayed event, second add)', () => {
    const { feed, alerts } = setup();
    const add = creatorAdds('A', 'CRE', T0 + 5);
    feed(tokenCreate('A', 'CRE', T0), add, add, creatorAdds('A', 'CRE', T0 + 9, 1));
    expect(alerts('red')).toHaveLength(1);
  });

  it('a symbolic add still fires (no threshold) but without the fingerprint', () => {
    const { feed, alerts } = setup();
    feed(tokenCreate('A', 'CRE', T0), creatorAdds('A', 'CRE', T0 + 5, 0.01));
    expect(alerts('red')[0]?.evidence).toMatchObject({ quoteAmount: '0.01', fingerprint: false });
  });

  it('fires even when the add arrives BEFORE the token_create (released from the pending buffer)', () => {
    const { feed, alerts } = setup();
    feed(creatorAdds('A', 'CRE', T0 + 5));
    expect(alerts()).toEqual([]);
    feed(tokenCreate('A', 'CRE', T0));
    expect(alerts('red')).toHaveLength(1);
  });
});

describe('Detector: confirmed rugs on TRADABLE liquidity', () => {
  it('confirms the red case (creator-pull) and links the alert with its lead', () => {
    const { feed, rugs } = setup();
    feed(tokenCreate('A', 'CRE', T0), graduation('A', 'CRE', T0 + 1), creatorAdds('A', 'CRE', T0 + 5));
    feed(liquidity('A', T0 + 505, { provider: 'CRE', kind: 'remove', movedSol: 95, quoteReserveSol: 0 }));
    expect(rugs()).toHaveLength(1);
    expect(rugs()[0]).toMatchObject({
      mint: 'A',
      mechanism: 'creator-pull',
      at: T0 + 505,
      trigger: { type: 'liquidity', actor: 'CRE' },
      alerts: [{ id: 'red:A', level: 'red', leadSeconds: 500 }],
    });
  });

  it('ignores the SOL stranded in the launchpad curve pool: a drained damm2 is a rug (dev dump)', () => {
    const { store, feed, rugs } = setup();
    feed(tokenCreate('B', 'DEV', T0, { dex: 'meteora_dbc' }), graduation('B', 'DEV', T0 + 1));
    feed(liquidity('B', T0 + 2, { pool: 'curve-B', dex: 'meteora_dbc', quoteReserveSol: 12 })); // stranded, not tradable
    feed(swap('B', T0 + 3, { pool: 'amm-B', quoteReserveSol: 20 })); // $2,000 tradable
    feed(swap('B', T0 + 60, { pool: 'amm-B', quoteReserveSol: 0.01, trader: 'DEV' })); // $1 left
    expect(rugs()).toMatchObject([{ mint: 'B', mechanism: 'dev-dump', trigger: { type: 'swap', actor: 'DEV' }, peakUsd: '2000.00', lastUsd: '1.00' }]);
    expect(currentLiquidityUsd(store.token('B')!)?.toNumber()).toBe(1); // the phase-3 sum said $1,201
  });

  it('a pool announced by the launchpad (pool_create dex=pumpfun) that trades as pumpswap is TRADABLE', () => {
    // Real case (HGLzDF…pump): the AMM pool is first announced with the launchpad's dex. Counting it as
    // a curve pool made a drained side pool look like the whole token: 30 false rugs over the night.
    const { store, feed, rugs } = setup();
    const announced = event({ ...poolCreateRaw('P', T0 + 1), dex: 'pumpfun' });
    feed(tokenCreate('P', 'X', T0), announced, graduation('P', 'X', T0 + 1));
    feed(swap('P', T0 + 2, { pool: 'amm-P', quoteReserveSol: 15 })); // $1,500 in the real AMM
    feed(swap('P', T0 + 3, { pool: 'side-P', dex: 'meteora_damm2', quoteReserveSol: 20 }));
    feed(swap('P', T0 + 4, { pool: 'side-P', dex: 'meteora_damm2', quoteReserveSol: 0 })); // a side pool empties
    expect(rugs()).toEqual([]);
    expect(currentLiquidityUsd(store.token('P')!)?.toNumber()).toBe(1500);
  });

  it('classifies a creator removing liquidity it never added as migration-pull, and others as sell-off', () => {
    const { feed, rugs } = setup();
    feed(tokenCreate('C', 'MIG', T0), graduation('C', 'MIG', T0 + 1), swap('C', T0 + 2, { quoteReserveSol: 30 }));
    feed(liquidity('C', T0 + 10, { provider: 'MIG', kind: 'remove', quoteReserveSol: 0 }));
    feed(tokenCreate('D', 'X', T0), graduation('D', 'X', T0 + 1), swap('D', T0 + 2, { quoteReserveSol: 30 }));
    feed(swap('D', T0 + 10, { quoteReserveSol: 0.001, trader: 'crowd' }));
    expect(rugs().map((r) => [r.mint, r.mechanism])).toEqual([
      ['C', 'migration-pull'],
      ['D', 'sell-off'],
    ]);
  });

  it('needs a real peak, and only counts graduated tokens', () => {
    const { feed, rugs } = setup();
    feed(tokenCreate('E', 'X', T0), graduation('E', 'X', T0 + 1), swap('E', T0 + 2, { quoteReserveSol: 5 })); // $500 < $1,000
    feed(swap('E', T0 + 3, { quoteReserveSol: 0 }));
    feed(tokenCreate('F', 'X', T0), swap('F', T0 + 2, { quoteReserveSol: 30 }), swap('F', T0 + 3, { quoteReserveSol: 0 })); // never graduated
    expect(rugs()).toEqual([]);
  });

  it('confirms a token once', () => {
    const { feed, rugs } = setup();
    feed(tokenCreate('C', 'X', T0), graduation('C', 'X', T0 + 1), swap('C', T0 + 2, { quoteReserveSol: 30 }));
    feed(swap('C', T0 + 3, { quoteReserveSol: 0 }), swap('C', T0 + 4, { quoteReserveSol: 0 }));
    expect(rugs()).toHaveLength(1);
  });
});

describe('Detector: AMBER — repeat rugger', () => {
  /** Creator R drains token R1 at T0+100. */
  const drained = () => [
    tokenCreate('R1', 'R', T0),
    graduation('R1', 'R', T0 + 1),
    swap('R1', T0 + 2, { quoteReserveSol: 30 }),
    swap('R1', T0 + 100, { quoteReserveSol: 0, trader: 'R' }),
  ];

  it('fires when a token of a creator who already drained another one graduates', () => {
    const { feed, alerts } = setup();
    feed(...drained(), tokenCreate('R2', 'R', T0 + 200), graduation('R2', 'R', T0 + 201));
    expect(alerts('amber')).toHaveLength(1);
    expect(alerts('amber')[0]).toMatchObject({
      rule: 'repeat-rugger',
      mint: 'R2',
      at: T0 + 201,
      trigger: { type: 'graduation', signature: null },
      evidence: { priorRugCount: 1, priorRugs: [{ mint: 'R1', at: T0 + 100, mechanism: 'dev-dump' }] },
      confidence: { confirmed: 359, fired: 435 },
    });
  });

  it('does not fire for a graduation BEFORE the first drain (even arriving late), nor for a clean creator', () => {
    const { feed, alerts } = setup();
    feed(...drained());
    // Out of order (e.g. a reconnect backfill): R0 graduated at T0+50, before R1 was drained at T0+100.
    feed(tokenCreate('R0', 'R', T0), graduation('R0', 'R', T0 + 50));
    feed(tokenCreate('Z', 'CLEAN', T0 + 200), graduation('Z', 'CLEAN', T0 + 201));
    expect(alerts('amber')).toEqual([]);
  });

  it('red and amber are separate levels on the same token, each deduplicated', () => {
    const { feed, alerts } = setup();
    feed(...drained(), tokenCreate('R2', 'R', T0 + 200), graduation('R2', 'R', T0 + 201), graduation('R2', 'R', T0 + 201));
    feed(creatorAdds('R2', 'R', T0 + 210));
    expect(alerts().map((a) => a.id).sort()).toEqual(['amber:R2', 'red:R2']);
  });
});

describe('Detector: registry and live precision', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('survives a restart: no re-raised alert, the rugger is remembered, precision counts both', () => {
    dir = mkdtempSync(join(tmpdir(), 'registry-'));
    const now = (T0 + 1000) * 1000;
    const registry = new Registry(dir, () => now);
    const first = setup();
    first.feed(
      tokenCreate('A', 'CRE', T0), graduation('A', 'CRE', T0 + 1), creatorAdds('A', 'CRE', T0 + 5),
      liquidity('A', T0 + 505, { provider: 'CRE', kind: 'remove', quoteReserveSol: 0 }),
    );
    first.records.forEach((r) => registry.append(r));

    const reloaded = new Registry(dir, () => now).load(7);
    expect(reloaded.map((r) => r.kind)).toEqual(['alert', 'rug']);
    const second = setup(reloaded);
    second.feed(tokenCreate('A', 'CRE', T0), creatorAdds('A', 'CRE', T0 + 5)); // a backfill replays the add
    second.feed(tokenCreate('A2', 'CRE', T0 + 600), graduation('A2', 'CRE', T0 + 601));
    expect(second.alerts().map((a) => a.id)).toEqual(['amber:A2']);
    expect(second.detector.stats().alerts.red).toMatchObject({ fired: 1, confirmed: 1, precision: 1, medianLeadSeconds: 500 });
  });

  it('an alert with no rug is open, then unconfirmed after liveResolveMinutes (event time)', () => {
    const { feed, detector } = setup();
    const resolve = testConfig().detection.liveResolveMinutes * 60;
    feed(tokenCreate('A', 'CRE', T0), creatorAdds('A', 'CRE', T0 + 5));
    expect(detector.stats().alerts.red).toMatchObject({ fired: 1, open: 1, unconfirmed: 0, precision: null });
    feed(tokenCreate('LATER', 'other', T0 + 5 + resolve + 1)); // moves the watermark
    expect(detector.stats().alerts.red).toMatchObject({ fired: 1, open: 0, unconfirmed: 1, precision: 0 });
  });

  it('skips corrupt lines instead of failing the startup, and ignores files older than reloadDays', () => {
    dir = mkdtempSync(join(tmpdir(), 'registry-'));
    const day = (s: number) => new Date(s * 1000).toISOString().slice(0, 10).replaceAll('-', '');
    writeFileSync(join(dir, `detector-${day(T0)}.jsonl`), '{"kind":"rug","mint":"M"}\nnot json\n{"kind":"other"}\n');
    writeFileSync(join(dir, `detector-${day(T0 - 30 * 86_400)}.jsonl`), '{"kind":"rug","mint":"OLD"}\n');
    const registry = new Registry(dir, () => T0 * 1000);
    expect(registry.load(7).map((r) => (r as RugRecord).mint)).toEqual(['M']);
    expect(registry.health()).toMatchObject({ loaded: 1, skippedLines: 2 });
  });
});
