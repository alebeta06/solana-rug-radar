/**
 * Phase-4 validation: the WHOLE night capture through the real detector (same store, same
 * listener wiring as `main.ts`), compared with the numbers of docs/ANALISIS_calibracion.md.
 * If they do not match, the detector is wrong, not the analysis.
 *
 * Usage: node --expose-gc dist/calibration/validate.js 20260926
 */
import { writeFileSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { secondsValue } from '../core/time.js';
import type { Detector } from '../detector/detector.js';
import { createDetector } from '../detector/factory.js';
import type { Alert, DetectorRecord, RugRecord } from '../detector/types.js';
import { createStateStore } from '../state/factory.js';
import { captureFiles, lifecycleMints, mergedReplay } from './capture.js';

/** What the analysis measured (tradable metric), to compare side by side. */
const EXPECTED = {
  red: { fired: 431, confirmed: 422 },
  amber: { fired: 435, confirmed: 359 },
  union: { fired: 866, confirmed: 781 },
  rugs: 1196,
  byMechanism: { 'creator-pull': 422, 'migration-pull': 268, 'dev-dump': 462, 'third-party-remove + sell-off': 44 },
  redLead: { p5: 189, p10: 322, p50: 485, p90: 597 },
  fingerprint: 425,
};

const q = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))] ?? NaN;
const row = (name: string, got: number | string, expected: number | string) =>
  console.log(`${name.padEnd(46)} ${String(got).padStart(8)}   analysis ${String(expected).padStart(6)}${String(got) === String(expected) ? '' : '   ← differs'}`);

async function main(): Promise<void> {
  const prefix = process.argv[2] ?? '20260926';
  const config = loadConfig();
  const capture = captureFiles('data/live', prefix);
  const store = createStateStore(config);
  const records: DetectorRecord[] = [];
  const detector: Detector = createDetector(config, store, (r) => records.push(r));
  store.listen(detector);
  const replay = mergedReplay(capture, await lifecycleMints(capture), config.stream.dedupWindowPerType);
  const started = Date.now();
  let end = 0;
  for await (const e of replay.events()) {
    store.apply(e);
    if ('blockTime' in e) end = Math.max(end, secondsValue(e.blockTime));
  }
  console.log(`replayed ${capture.lifecycle.length + capture.firehose.length} files in ${((Date.now() - started) / 1000).toFixed(0)} s`);

  const alerts = records.filter((r): r is Alert => r.kind === 'alert');
  const rugs = records.filter((r): r is RugRecord => r.kind === 'rug');
  const rugOf = new Map(rugs.map((r) => [r.mint, r]));
  const ids = new Set<string>();
  const duplicates = alerts.filter((a) => (ids.has(a.id) ? true : (ids.add(a.id), false))).length;
  const level = (l: 'red' | 'amber') => {
    const fired = alerts.filter((a) => a.level === l);
    const confirmed = fired.filter((a) => rugOf.has(a.mint));
    const late = fired.filter((a) => !rugOf.has(a.mint) && end - a.at < 3600);
    return { fired, confirmed, late };
  };
  const red = level('red');
  const amber = level('amber');
  console.log('\n## Alerts (confirmed = the same token later gets a confirmed rug)');
  row('red fired', red.fired.length, EXPECTED.red.fired);
  row('red confirmed', red.confirmed.length, EXPECTED.red.confirmed);
  console.log(`  red precision ${(100 * red.confirmed.length / red.fired.length).toFixed(1)}%; unconfirmed raised < 1 h before the end: ${red.late.length}`);
  row('amber fired', amber.fired.length, EXPECTED.amber.fired);
  row('amber confirmed', amber.confirmed.length, EXPECTED.amber.confirmed);
  console.log(`  amber precision ${(100 * amber.confirmed.length / amber.fired.length).toFixed(1)}%; unconfirmed raised < 1 h before the end: ${amber.late.length}`);
  const mints = new Set(alerts.map((a) => a.mint));
  const unionConfirmed = [...mints].filter((m) => rugOf.has(m)).length;
  row('red OR amber: tokens alerted', mints.size, EXPECTED.union.fired);
  row('red OR amber: confirmed', unionConfirmed, EXPECTED.union.confirmed);
  console.log(`  union precision ${(100 * unionConfirmed / mints.size).toFixed(1)}%; recall over all rugs ${(100 * unionConfirmed / rugs.length).toFixed(1)}%`);
  row('duplicate alerts (same level, same token)', duplicates, 0);
  row('red alerts with the 85-SOL fingerprint', alerts.filter((a) => 'fingerprint' in a.evidence && a.evidence.fingerprint).length, EXPECTED.fingerprint);

  const lead = red.confirmed.map((a) => rugOf.get(a.mint)!.at - a.at);
  console.log(`\n## Red lead (alert → confirmed rug), n=${lead.length}`);
  for (const [p, v] of Object.entries(EXPECTED.redLead)) row(`lead ${p} (s)`, q(lead, Number(p.slice(1)) / 100), v);
  console.log(`  min ${Math.min(...lead)} s; < 60 s: ${lead.filter((v) => v < 60).length}; < 120 s: ${lead.filter((v) => v < 120).length}`);
  const amberLead = amber.confirmed.map((a) => rugOf.get(a.mint)!.at - a.at);
  console.log(`  amber lead p10 ${q(amberLead, 0.1)} s, p50 ${q(amberLead, 0.5)} s, p90 ${q(amberLead, 0.9)} s (analysis: 36 / 129 / 1132 s)`);

  console.log('\n## Confirmed rugs');
  row('total', rugs.length, EXPECTED.rugs);
  const by = (m: string) => rugs.filter((r) => r.mechanism === m).length;
  row('creator-pull', by('creator-pull'), EXPECTED.byMechanism['creator-pull']);
  row('migration-pull', by('migration-pull'), EXPECTED.byMechanism['migration-pull']);
  row('dev-dump', by('dev-dump'), EXPECTED.byMechanism['dev-dump']);
  row('third-party-remove + sell-off', by('third-party-remove') + by('sell-off'), EXPECTED.byMechanism['third-party-remove + sell-off']);
  console.log('\n## Detector stats (as /health shows them)', JSON.stringify(detector.stats()));

  writeFileSync(`data/calibration/${prefix}-detector.json`, JSON.stringify(records)); // to diff against the analysis
  const gc = (globalThis as { gc?: () => void }).gc;
  records.length = 0;
  gc?.();
  console.log(`\nretained heap after the night (store + detector): ${Math.round(process.memoryUsage().heapUsed / 1e6)} MB${gc ? '' : ' (run with --expose-gc for a clean number)'}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
