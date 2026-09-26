/**
 * Offline analysis: replays JSONL captures through the memory (phase 3) with the REST budget
 * SIMULATED on event time, and prints what it learned: serial creators, liquidity collapses,
 * what the enrichment policy would have asked and discarded, memory used. Material to
 * calibrate the phase-4 thresholds. Usage: node dist/analyze.js [file.jsonl | dir]...
 */
import { Decimal } from 'decimal.js';
import { loadConfig } from './config.js';
import { secondsValue } from './core/time.js';
import { createReplaySource } from './ingest/factory.js';
import { applyEvent, createEnricher, createStateStore, stateHealth } from './state/factory.js';
import { outcomeOf } from './state/token-state.js';
import type { TokenOutcome } from './state/types.js';

const COLLAPSED_BELOW_USD = new Decimal(5);
const HAD_LIQUIDITY_USD = new Decimal(1000);

async function main(): Promise<number> {
  const config = loadConfig();
  const source = createReplaySource(config, process.argv.length > 2 ? process.argv.slice(2) : ['data/live']);
  if (source.files.length === 0) {
    console.error('no .jsonl files found');
    return 1;
  }
  const store = createStateStore(config);
  const enricher = createEnricher(config, store, null);
  const started = Date.now();
  let events = 0;
  let peakTokens = 0;
  let peakHeapMB = 0;
  let first: number | null = null;
  for await (const event of source.events()) {
    applyEvent(store, enricher, event);
    enricher.tick();
    events += 1;
    if (first === null && store.watermark !== null) first = secondsValue(store.watermark);
    if (events % 20_000 === 0) {
      peakTokens = Math.max(peakTokens, store.tokens.size);
      peakHeapMB = Math.max(peakHeapMB, process.memoryUsage().heapUsed / 1e6);
    }
  }
  const seconds = (Date.now() - started) / 1000;
  const health = stateHealth(store, enricher);
  const m = source.health().malformed;
  const span = first === null || health.watermark === null ? 0 : (secondsValue(health.watermark) - first) / 3600;

  console.log(`\n== Replay: ${events} events from ${source.files.length} file(s), ${span.toFixed(1)} h of event time, in ${seconds.toFixed(0)} s`);
  console.log(`   rejected frames: ${m.invalidJson + m.notAnObject + m.unknownType + m.invalidShape}`);
  for (const entry of m.recent) console.log(`   REJECTED ${entry}`);

  // Every launch outcome we know: tokens still tracked + tokens already folded into creators.
  const outcomes = new Map<string, { creator: string | null; outcome: TokenOutcome }>();
  for (const creator of store.creators.values()) {
    for (const launch of creator.launches.values()) {
      if (launch.outcome !== null) outcomes.set(launch.mint, { creator: creator.creator, outcome: launch.outcome });
    }
  }
  for (const token of store.tokens.values()) outcomes.set(token.mint, { creator: token.creator, outcome: outcomeOf(token) });

  const serial = [...store.creators.values()].filter((c) => c.serial);
  const serialSet = new Set(serial.map((c) => c.creator));
  const collapsed = (o: TokenOutcome) =>
    o.peakLiquidityUsd !== null && o.peakLiquidityUsd.gte(HAD_LIQUIDITY_USD) && o.lastLiquidityUsd !== null && o.lastLiquidityUsd.lte(COLLAPSED_BELOW_USD);
  let collapsedAll = 0;
  let collapsedSerial = 0;
  let graduatedAll = 0;
  let graduatedSerial = 0;
  for (const { creator, outcome } of outcomes.values()) {
    const bySerial = creator !== null && serialSet.has(creator);
    if (outcome.stage === 'graduated') {
      graduatedAll += 1;
      if (bySerial) graduatedSerial += 1;
    }
    if (collapsed(outcome)) {
      collapsedAll += 1;
      if (bySerial) collapsedSerial += 1;
    }
  }

  const threshold = config.detection.launchBurst.maxNormalLaunches;
  console.log(`\n== Creators: ${health.creators.known} known; ${serial.length} crossed > ${threshold} launches / ${config.detection.launchBurst.windowHours} h`);
  console.log(`   launches seen: ${health.launchesSeen}; by serial creators: ${serial.reduce((s, c) => s + c.launches.size, 0)}`);
  const histogram: Record<string, number> = { '1': 0, '2-3': 0, '4-10': 0, '11-30': 0, '31-100': 0, '>100': 0 };
  for (const c of store.creators.values()) {
    const n = c.launches.size;
    const bucket = n <= 1 ? '1' : n <= 3 ? '2-3' : n <= 10 ? '4-10' : n <= 30 ? '11-30' : n <= 100 ? '31-100' : '>100';
    histogram[bucket] = (histogram[bucket] ?? 0) + 1;
  }
  console.log(`   launches per creator: ${JSON.stringify(histogram)}`);
  console.log('   top serial creators (launches, graduated, collapsed, last stream liquidity of collapsed):');
  for (const c of serial.sort((a, b) => b.launches.size - a.launches.size).slice(0, 12)) {
    const mine = [...c.launches.keys()].map((mint) => outcomes.get(mint)?.outcome).filter((o) => o !== undefined);
    const lasts = mine.filter(collapsed).map((o) => o.lastLiquidityUsd?.toFixed(2));
    console.log(
      `     ${c.creator} ${c.launches.size} launched, ${mine.filter((o) => o.stage === 'graduated').length} graduated, ` +
        `${lasts.length} collapsed [${lasts.slice(0, 6).join(', ')}${lasts.length > 6 ? ', …' : ''}]`,
    );
  }

  console.log(`\n== Tokens: ${outcomes.size} with an outcome; ${graduatedAll} graduated (${graduatedSerial} by serial creators)`);
  console.log(
    `   collapsed (stream quote-side peak >= $${HAD_LIQUIDITY_USD.toString()} then <= $${COLLAPSED_BELOW_USD.toString()}): ${collapsedAll} ` +
      `(${collapsedSerial} by serial creators)`,
  );

  const e = health.enrichment;
  if (e !== null) {
    console.log(`\n== REST budget, simulated at ${config.rest.requestsPerSecond} req/s on event time`);
    console.log(`   dispatched  ${JSON.stringify(e.dispatched)}  (total ${e.sent})`);
    console.log(`   discarded (queue full) ${JSON.stringify(e.discardedFull)}`);
    console.log(`   discarded (waited > ${config.enrichment.maxWaitMinutes} min) ${JSON.stringify(e.discardedStale)}`);
    console.log(`   mean wait s ${JSON.stringify(e.meanWaitSeconds)}; still pending ${e.pending}`);
  }

  console.log(`\n== Memory: now ${health.tokens.tracked} tokens / ${health.creators.known} creators / ${health.readings} readings;`);
  console.log(`   peak ${peakTokens} tokens tracked; heap peak ~${peakHeapMB.toFixed(0)} MB, now ${health.memory.heapUsedMB} MB`);
  console.log(`   evicted ${JSON.stringify(health.evicted)}; late events ${health.lateEvents}; unpriced readings ${health.unpricedReadings}`);
  console.log(`   pending (out-of-order) ${JSON.stringify(health.pending)}`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
