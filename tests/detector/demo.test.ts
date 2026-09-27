/**
 * The bundled demo capture (samples/demo-20260926.jsonl.gz, built by src/calibration/demo.ts)
 * through the real pipeline, wired as main.ts wires a replay. It must reproduce, record by record,
 * what the phase-4 validation of the whole night produced for the same tokens
 * (tests/fixtures/demo-expected.json, taken from that run), and pacing must not change a thing.
 *
 * One tolerance: `peakUsd`. USD values use the SOL price the store estimates from EVERY tracked
 * token's swaps (quote_usd / quote_amount); the demo carries only its 17 tokens, so the estimate
 * differs by cents (at most 0.15 % measured). Everything else, `lastUsd` included, must be equal.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { unixMillis } from '../../src/core/time.js';
import { createDetector } from '../../src/detector/factory.js';
import type { DetectorRecord } from '../../src/detector/types.js';
import { ReplaySource } from '../../src/ingest/replay-source.js';
import { applyEvent, createEnricher, createStateStore } from '../../src/state/factory.js';

const DEMO = 'samples/demo-20260926.jsonl.gz';
/** 2026-09-26 15:09:09 UTC: the newest block time in the demo capture. */
const LAST_BLOCK_TIME = 1790435349;
const expected = JSON.parse(readFileSync('tests/fixtures/demo-expected.json', 'utf8')) as unknown[];

/** `detectedAt` is the local receive time: the only field allowed to depend on when the replay runs. */
const withoutReceiveTime = (records: DetectorRecord[]) => records.map((r) => ({ ...r, detectedAt: undefined }));
const withoutPeak = (records: readonly object[]) => records.map((r) => ({ ...r, peakUsd: undefined }));
const peaks = (records: readonly object[]) => records.map((r) => ('peakUsd' in r ? Number(r.peakUsd) : null));

function expectSameAsValidation(records: DetectorRecord[]): void {
  expect(withoutPeak(withoutReceiveTime(records))).toEqual(withoutPeak(expected as object[]));
  const want = peaks(expected as object[]);
  peaks(records).forEach((got, i) => {
    if (got === null) expect(want[i]).toBeNull();
    else expect(Math.abs(got / want[i]! - 1)).toBeLessThan(0.005);
  });
}

async function run(speed: number) {
  const config = loadConfig({});
  // A fake wall clock that starts now and only moves when the source sleeps: 1× takes no real time.
  let wall = Date.now();
  let slept = 0;
  const source = new ReplaySource({
    paths: [DEMO],
    dedupWindowPerType: config.stream.dedupWindowPerType,
    speed,
    clock: () => unixMillis(wall),
    sleep: (ms) => {
      wall += ms;
      slept += ms;
      return Promise.resolve();
    },
  });
  const store = createStateStore(config);
  const enricher = createEnricher(config, store, null);
  const records: DetectorRecord[] = [];
  const detector = createDetector(config, store, (r) => records.push(r));
  store.listen(detector);
  for await (const event of source.events()) {
    applyEvent(store, enricher, event);
    enricher.tick();
  }
  return { records, slept, frames: source.health().frames, watermark: store.watermark, stats: detector.stats() };
}

describe('demo capture', { timeout: 120_000 }, () => {
  it('reproduces the phase-4 validation records of its tokens, in the same order', async () => {
    const { records, frames } = await run(0);
    expect(frames).toBeGreaterThan(30_000);
    expectSameAsValidation(records);
  });

  it('shows hits AND limits: confirmed reds, an amber that did not confirm, drains nobody warned about', () => {
    const rugs = expected.filter((r): r is { kind: 'rug'; mechanism: string; alerts: unknown[] } => (r as { kind: string }).kind === 'rug');
    const alerts = expected.filter((r): r is { kind: 'alert'; level: string; mint: string } => (r as { kind: string }).kind === 'alert');
    const drained = new Set(rugs.map((r) => (r as unknown as { mint: string }).mint));
    expect(alerts.filter((a) => a.level === 'red' && drained.has(a.mint)).length).toBeGreaterThanOrEqual(5);
    expect(alerts.some((a) => a.level === 'amber' && drained.has(a.mint))).toBe(true);
    expect(alerts.some((a) => a.level === 'amber' && !drained.has(a.mint))).toBe(true);
    expect(rugs.filter((r) => r.alerts.length === 0).map((r) => r.mechanism).sort()).toEqual(['dev-dump', 'dev-dump', 'migration-pull']);
  });

  it('gives exactly the same records at 1× and at 20× (pacing only delays delivery)', async () => {
    const [fast, slow] = await Promise.all([run(20), run(1)]);
    expectSameAsValidation(slow.records);
    expect(withoutReceiveTime(fast.records)).toEqual(withoutReceiveTime(slow.records));
    // Pacing really happened: the recording spans 13:28–15:10 (≈ 100 min of event time).
    expect(slow.slept / 60_000).toBeGreaterThan(95);
    expect(fast.slept * 20).toBeCloseTo(slow.slept, -4);
    // The clock stays on event time at any speed: the screen shows the recording's clock and
    // resolves alerts on it (a wall-clock watermark changes no record here, but breaks this).
    for (const r of [fast, slow]) {
      expect(r.watermark).toBe(LAST_BLOCK_TIME);
      expect(r.stats.alerts).toMatchObject({
        red: { fired: 10, confirmed: 10, unconfirmed: 0, open: 0 },
        // GbKawFenQ2: amber at 14:03:53, no drain by 15:03:53 → unconfirmed, on the recording's clock.
        amber: { fired: 4, confirmed: 3, unconfirmed: 1, open: 0 },
      });
    }
    expect(fast.stats).toEqual(slow.stats);
  });
});
