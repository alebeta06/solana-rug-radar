/**
 * Q5 of the calibration: our collapse metric (stream, quote side) vs Solami's `liquidity_usd`
 * (dev-history), on a seeded, stratified sample of the features written by ./extract.ts.
 * Every disagreement is diagnosed with the pool reserves the stream showed last.
 *
 * Usage: node --env-file=.env dist/calibration/solami.js 20260926   (~1 req/s, ~5 min)
 */
import { readFileSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { createRestClient } from '../state/factory.js';
import { CURVE_DEXES } from './capture.js';
import type { CaptureFeatures, TokenFeatures } from './extract.js';

const HAD = 1000;
const LOW = 5;
type Tok = TokenFeatures & { mint: string };

function seededShuffle<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

async function main(): Promise<void> {
  const prefix = process.argv[2] ?? '20260926';
  const d = JSON.parse(readFileSync(`data/calibration/${prefix}.json`, 'utf8')) as CaptureFeatures;
  const toks: Tok[] = Object.entries(d.tokens).map(([mint, x]) => ({ ...x, mint })).filter((x) => x.outcome !== undefined);
  const collapsed = (x: Tok) => x.outcome!.peak !== null && x.outcome!.peak >= HAD && x.outcome!.last !== null && x.outcome!.last <= LOW;
  const creatorAdd = (x: Tok) => x.liq.some((r) => r[1] === 0 && r[2] === x.creator);
  const grad = (x: Tok) => x.outcome!.stage === 'graduated';
  // Graduated tokens with a tradable reading use it; the rest keep the phase-3 verdict.
  const tradableCollapsed = (x: Tok) => (grad(x) && x.tradablePeak !== null ? x.tradablePeak >= HAD && x.tradableLast !== null && x.tradableLast <= LOW : collapsed(x));
  const strata: [string, Tok[], number][] = [
    ['collapsed, creator add (A)', toks.filter((x) => collapsed(x) && creatorAdd(x)), 70],
    ['collapsed, graduated, no creator add (C)', toks.filter((x) => collapsed(x) && grad(x) && !creatorAdd(x)), 70],
    ['collapsed on the curve (B)', toks.filter((x) => collapsed(x) && !grad(x)), 30],
    ['graduated, alive at the end (peak ≥ $1k, last > $5)', toks.filter((x) => grad(x) && !collapsed(x) && (x.outcome!.peak ?? 0) >= HAD), 100],
  ];
  const client = createRestClient(loadConfig());
  const asked = new Set<string>();
  console.log(`capture end ${new Date(d.end * 1000).toISOString()}; queried from ${new Date().toISOString()}`);
  console.log('stratum | mint | phase-3 last/peak $ | tradable last/peak $ | Solami $ | holders | SOL in curve pools | SOL in tradable pools | last pool event before end (min) | verdict phase-3 ‖ tradable');
  const verdicts: Record<string, Record<string, number>> = {};
  let seed = 3;
  for (const [name, list, n] of strata) {
    let done = 0;
    for (const x of seededShuffle(list, (seed += 7))) {
      if (done === n) break;
      if (x.creator === null || asked.has(x.creator)) continue;
      asked.add(x.creator);
      let verdict: string;
      let line: string;
      try {
        const h = await client.getCreatorHistory(x.mint);
        const t = h.tokens.find((y) => y.mint === x.mint);
        if (t === undefined) {
          verdict = 'not listed by dev-history';
          line = `${name} | ${x.mint} | ${verdict}`;
        } else {
          const solami = t.liquidityUsd.toNumber();
          const pools = Object.values(x.pools);
          const curveSol = pools.filter((p) => CURVE_DEXES.has(p.dex)).reduce((sum, p) => sum + (p.sol ?? 0), 0);
          const tradableSol = pools.filter((p) => !CURVE_DEXES.has(p.dex)).reduce((sum, p) => sum + (p.sol ?? 0), 0);
          const lastPool = Math.max(...pools.map((p) => p.t), 0);
          const theirs = solami <= LOW;
          const judge = (ours: boolean, peak: number | null) => {
            if (ours === theirs) return ours ? 'agree: collapsed' : 'agree: alive';
            if (ours) return peak !== null && solami >= 1.4 * peak && solami <= 2.6 * peak ? 'Solami high: ≈ 2 × our peak (value before the drain)' : 'Solami high: other';
            if (grad(x) && curveSol > 0.05 && x.tradableLast !== null && x.tradableLast <= LOW) return 'Solami low: tradable pool empty, SOL left in the curve pool';
            return d.end - lastPool < 1800 ? 'Solami low: pool active <30 min before our end' : 'Solami low: pool quiet ≥30 min before our end';
          };
          verdict = `${judge(collapsed(x), x.outcome!.peak)} ‖ tradable: ${judge(tradableCollapsed(x), x.tradablePeak ?? x.outcome!.peak)}`;
          line = `${name} | ${x.mint} | ${x.outcome!.last?.toFixed(2)}/${x.outcome!.peak?.toFixed(0)} | ${x.tradableLast?.toFixed(2) ?? '–'}/${x.tradablePeak?.toFixed(0) ?? '–'} | ${solami.toFixed(2)} | ${t.holders} | ${curveSol.toFixed(3)} | ${tradableSol.toFixed(3)} | ${((d.end - lastPool) / 60).toFixed(0)} | ${verdict}`;
        }
      } catch (error) {
        verdict = `error ${error instanceof Error ? error.message : String(error)}`;
        line = `${name} | ${x.mint} | ${verdict}`;
      }
      console.log(line);
      const v = (verdicts[name] ??= {});
      v[verdict] = (v[verdict] ?? 0) + 1;
      done += 1;
    }
  }
  console.log('\nsummary');
  for (const [name, v] of Object.entries(verdicts)) console.log(name, JSON.stringify(v));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
