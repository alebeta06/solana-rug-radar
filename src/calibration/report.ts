/**
 * Calibration report over the features written by ./extract.ts (docs/ANALISIS_calibracion.md).
 * Prints tables; decides nothing. Usage: node dist/calibration/report.js 20260926 [--tradable]
 *   --tradable: for graduated tokens, "collapse" uses TRADABLE liquidity (launchpad curve pools
 *   excluded, see extract.ts) instead of the phase-3 metric. Curve tokens are unchanged.
 */
import { readFileSync } from 'node:fs';
import type { CaptureFeatures, TokenFeatures } from './extract.js';

const HAD = 1000;
const LOW = 5;

// ---------- helpers ----------
const q = (xs: number[], p: number) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const fmt = (v: number) => (Number.isNaN(v) ? '–' : Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2));
const pct = (a: number, b: number) => (b === 0 ? '–' : `${((100 * a) / b).toFixed(1)}%`);
const dist = (xs: number[]) =>
  `n=${xs.length} min ${fmt(Math.min(...xs))} p5 ${fmt(q(xs, 0.05))} p10 ${fmt(q(xs, 0.1))} p25 ${fmt(q(xs, 0.25))} p50 ${fmt(q(xs, 0.5))} p75 ${fmt(q(xs, 0.75))} p90 ${fmt(q(xs, 0.9))} max ${fmt(Math.max(...xs))}`;
/** AUC = P(value of a random positive > value of a random negative); ties count half. */
function auc(pos: number[], neg: number[]): number {
  if (pos.length === 0 || neg.length === 0) return NaN;
  const all = [...pos.map((v) => ({ v, p: 1 })), ...neg.map((v) => ({ v, p: 0 }))].sort((a, b) => a.v - b.v);
  let rankSum = 0;
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j < all.length && all[j]!.v === all[i]!.v) j += 1;
    for (let k = i; k < j; k += 1) if (all[k]!.p === 1) rankSum += (i + j + 1) / 2;
    i = j;
  }
  return (rankSum - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
}
const tally = <T>(xs: T[], key: (x: T) => string) => {
  const out: Record<string, number> = {};
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
};

// ---------- per-token derived facts ----------
type Tok = TokenFeatures & { mint: string };
const isCollapsed = (x: Tok) => x.outcome !== undefined && x.outcome.peak !== null && x.outcome.peak >= HAD && x.outcome.last !== null && x.outcome.last <= LOW;
const graduated = (x: Tok) => x.outcome?.stage === 'graduated';
const creatorAdds = (x: Tok) => x.liq.filter((r) => r[1] === 0 && x.creator !== null && r[2] === x.creator);
/** The main signal: the creator adds liquidity to its own token, before any collapse. */
const firstCreatorAdd = (x: Tok) => creatorAdds(x).filter((r) => x.collapseAt === null || r[0] <= x.collapseAt).sort((a, b) => a[0] - b[0])[0];
const removesBefore = (x: Tok) => x.liq.filter((r) => r[1] === 1 && (x.collapseAt === null || r[0] <= x.collapseAt));
/** Swaps while graduated as rows [t, sell, trader, solReserve]. */
const swaps = (x: Tok) => {
  const out: [number, number, number, number][] = [];
  for (let i = 0; i < x.sw.length; i += 4) out.push([x.sw[i]!, x.sw[i + 1]!, x.sw[i + 2]!, x.sw[i + 3]!]);
  return out;
};
const sellShare = (rows: [number, number, number, number][], minSwaps = 10) => (rows.length < minSwaps ? null : rows.filter((r) => r[1] === 1).length / rows.length);

function main(): void {
  const prefix = process.argv[2] ?? '20260926';
  const d = JSON.parse(readFileSync(`data/calibration/${prefix}.json`, 'utf8')) as CaptureFeatures;
  const tradable = process.argv.includes('--tradable');
  const raw: Tok[] = Object.entries(d.tokens).map(([mint, x]) => ({ ...x, mint }));
  const phase3 = (x: Tok) => isCollapsed(x);
  const tradableCollapsed = (x: Tok) => x.tradablePeak !== null && x.tradablePeak >= HAD && x.tradableLast !== null && x.tradableLast <= LOW;
  const g = raw.filter((x) => x.outcome !== undefined && graduated(x));
  console.log(`metric comparison on ${g.length} graduated tokens: both collapsed ${g.filter((x) => phase3(x) && tradableCollapsed(x)).length}; only phase-3 ${g.filter((x) => phase3(x) && !tradableCollapsed(x)).length}; only tradable ${g.filter((x) => !phase3(x) && tradableCollapsed(x)).length}; neither ${g.filter((x) => !phase3(x) && !tradableCollapsed(x)).length}; no tradable reading ${g.filter((x) => x.tradablePeak === null).length}`);
  const onlyTradable = g.filter((x) => !phase3(x) && tradableCollapsed(x));
  console.log('  only tradable, by launchpad → dex and mechanism', tally(onlyTradable, (x) => `${x.launchpad ?? '?'} → ${x.gradDex ?? '?'} · ${x.tradableCollapseBy ?? '?'}${x.tradableCollapseActor === x.creator ? ' by creator' : ''}`));
  const onlyPhase3 = g.filter((x) => phase3(x) && !tradableCollapsed(x));
  console.log('  only phase-3: tradable last $', onlyPhase3.map((x) => fmt(x.tradableLast ?? NaN)).join(' '));
  const toks: Tok[] = !tradable ? raw : raw.map((x) => x.outcome === undefined || !graduated(x) || x.tradablePeak === null ? x : {
    ...x, outcome: { ...x.outcome, peak: x.tradablePeak, last: x.tradableLast }, collapseAt: x.tradableCollapseAt, collapseBy: x.tradableCollapseBy, collapseActor: x.tradableCollapseActor,
  });
  console.log(tradable ? '### collapse = TRADABLE liquidity for graduated tokens' : '### collapse = phase-3 metric (all pools)');
  const withOutcome = toks.filter((x) => x.outcome !== undefined);
  const collapsed = withOutcome.filter(isCollapsed);
  const grads = withOutcome.filter(graduated);
  const hours = (d.end - d.start) / 3600;
  console.log(`capture ${prefix}: ${new Date(d.start * 1000).toISOString()} → ${new Date(d.end * 1000).toISOString()} (${hours.toFixed(1)} h)`);
  console.log(`tokens with outcome ${withOutcome.length}; created in capture ${toks.filter((x) => x.createdAt !== null).length}; graduated ${grads.length}; collapsed ${collapsed.length} (graduated ${collapsed.filter(graduated).length})`);
  console.log('replay', JSON.stringify(d.replay.byType), 'events', d.replay.events, 'skipped swap lines', d.replay.skippedSwapLines);
  const swapsKept = toks.reduce((s, x) => s + x.sw.length / 4, 0);
  console.log(`graduated-token swaps kept ${swapsKept}; curve swaps ${toks.reduce((s, x) => s + x.curveSwaps, 0)}; quote-leg duplicates ignored ${toks.reduce((s, x) => s + x.quoteLegSwaps, 0)}`);

  // ---------- §0 groups of collapses
  const group = (x: Tok): string => {
    if (firstCreatorAdd(x) !== undefined) return 'A creator add';
    if (!graduated(x)) return `B curve (${x.launchpad ?? '?'})`;
    if (x.createdAt === null) return 'C graduated, token_create not in capture';
    return `C graduated ${x.launchpad ?? '?'}, no creator add`;
  };
  console.log('\n## §0 collapses by group', tally(collapsed, group));

  // ---------- §4 (Q4) classify the collapsed graduated tokens without a creator add
  const cGroup = collapsed.filter((x) => graduated(x) && firstCreatorAdd(x) === undefined);
  const mechanism = (x: Tok): string => {
    const rem = removesBefore(x);
    const byCreator = rem.some((r) => r[2] === x.creator);
    const rows = swaps(x).filter((r) => x.collapseAt === null || r[0] <= x.collapseAt);
    const sells = rows.filter((r) => r[1] === 1);
    if (x.collapseBy === 'swap') {
      // who sold: one wallet dumping, or many?
      const bySeller = tally(sells, (r) => String(r[2]));
      const top = Object.values(bySeller)[0] ?? 0;
      const actorIsCreator = x.collapseActor === x.creator;
      return `drained by sells${actorIsCreator ? ' (last sell by the creator)' : ''}; ${top >= sells.length * 0.5 && sells.length > 0 ? 'one wallet ≥50% of sells' : 'many sellers'}`;
    }
    if (x.collapseBy?.startsWith('liquidity remove')) return byCreator ? 'removed by the creator (never added)' : 'removed by a third wallet';
    if (x.collapseBy === null) return `not seen live (outcome only; ${rem.length ? 'had removes' : 'no removes'}; ${rows.length} swaps)`;
    return x.collapseBy;
  };
  console.log(`\n## Q4 collapsed graduated tokens without a creator add: ${cGroup.length}`);
  console.log('by launchpad / graduation dex', tally(cGroup, (x) => `${x.launchpad ?? '?'} → ${x.gradDex ?? '?'}`));
  console.log('by mechanism', tally(cGroup, mechanism));
  const removers = tally(cGroup.flatMap((x) => removesBefore(x).filter((r) => r[2] !== x.creator).map((r) => r[2])), (w) => w);
  console.log('third-party removing wallets (tokens):', Object.entries(removers).slice(0, 8).map(([w, n]) => `${w.slice(0, 8)}…×${n}`).join(' '), `(distinct ${Object.keys(removers).length})`);
  const peaksC = cGroup.map((x) => x.outcome!.peak!);
  console.log(`peak quote-side liquidity of this group: ${dist(peaksC)}`);
  const gradToCollapse = cGroup.filter((x) => x.collapseAt !== null && x.gradAt !== null).map((x) => x.collapseAt! - x.gradAt!);
  console.log(`graduation → collapse s: ${dist(gradToCollapse)}`);
  const creatorsC = new Set(cGroup.map((x) => x.creator));
  const serialC = cGroup.filter((x) => x.creator !== null && d.creators[x.creator]?.serial).length;
  console.log(`distinct creators ${creatorsC.size}; tokens of serial creators ${serialC}`);
  const curve = collapsed.filter((x) => !graduated(x));
  console.log(`curve (never graduated) collapses ${curve.length}:`, tally(curve, (x) => x.launchpad ?? '?'), 'collapse by', tally(curve, (x) => x.collapseBy ?? 'outcome only (meme)'));

  // ---------- Q1 main signal
  console.log('\n## Q1 main signal: the creator adds liquidity to its own token (before any collapse)');
  const signal = withOutcome.filter((x) => firstCreatorAdd(x) !== undefined);
  const hit = signal.filter(isCollapsed);
  const miss = signal.filter((x) => !isCollapsed(x));
  console.log(`matches ${signal.length}; collapsed ${hit.length} (precision ${pct(hit.length, signal.length)}); distinct creators ${new Set(signal.map((x) => x.creator)).size}`);
  console.log('non-collapsed matches: seconds from the add to the end of the capture', miss.map((x) => d.end - firstCreatorAdd(x)![0]).sort((a, b) => a - b).join(','));
  console.log('non-collapsed matches: last liquidity $ / peak $', miss.map((x) => `${fmt(x.outcome!.last ?? NaN)}/${fmt(x.outcome!.peak ?? NaN)}`).join(' '));
  const denominators: [string, (x: Tok) => boolean][] = [
    ['all collapses (incl. curve)', () => true],
    ['collapses of graduated tokens ("pool rugs", any mechanism)', graduated],
    ['graduated, collapsed by a liquidity remove', (x) => graduated(x) && (x.collapseBy?.startsWith('liquidity remove') ?? false)],
    ['graduated, collapsed by a remove of the creator', (x) => graduated(x) && x.collapseBy?.startsWith('liquidity remove') === true && x.collapseActor === x.creator],
    ['graduated, drained by sells', (x) => graduated(x) && x.collapseBy === 'swap'],
  ];
  for (const [name, test] of denominators) {
    const den = collapsed.filter(test);
    console.log(`recall over ${name}: ${den.filter((x) => firstCreatorAdd(x) !== undefined).length}/${den.length} (${pct(den.filter((x) => firstCreatorAdd(x) !== undefined).length, den.length)})`);
  }
  const lead = hit.filter((x) => x.collapseAt !== null).map((x) => x.collapseAt! - firstCreatorAdd(x)![0]);
  console.log(`lead (first creator add → collapse) s: ${dist(lead)}`);
  console.log(`lead < 30 s: ${lead.filter((v) => v < 30).length}; < 60 s: ${lead.filter((v) => v < 60).length}; < 120 s: ${lead.filter((v) => v < 120).length}; same second: ${lead.filter((v) => v === 0).length}`);
  console.log('collapse mechanism of the hits', tally(hit, (x) => `${x.collapseBy ?? 'outcome only'}${x.collapseActor === x.creator ? ' by creator' : ''}`));
  console.log('hits by launchpad → dex of the creator add', tally(hit, (x) => `${x.launchpad ?? '?'} → ${firstCreatorAdd(x)![4]}`));
  const extracted = hit.map((x) => {
    const added = creatorAdds(x).reduce((s, r) => s + (r[5] ?? 0), 0);
    const removed = x.liq.filter((r) => r[1] === 1 && r[2] === x.creator).reduce((s, r) => s + (r[5] ?? 0), 0);
    return removed - added;
  });
  console.log(`net SOL extracted by the creator (removed − added): total ${fmt(extracted.reduce((a, b) => a + b, 0))} SOL; ${dist(extracted)}; creators losing SOL: ${extracted.filter((v) => v < 0).length}`);
  const perHour = tally(hit, (x) => new Date(firstCreatorAdd(x)![0] * 1000).toISOString().slice(11, 13));
  console.log('hits per UTC hour of the add', Object.fromEntries(Object.entries(perHour).sort()));

  // ---------- Q3 85 SOL
  console.log('\n## Q3 the 85 SOL pattern');
  const bins: [string, (v: number) => boolean][] = [
    ['<80', (v) => v < 80], ['80–84.9', (v) => v >= 80 && v < 84.9], ['84.9–85.1', (v) => v >= 84.9 && v <= 85.1], ['85.1–90', (v) => v > 85.1 && v <= 90], ['>90', (v) => v > 90],
  ];
  const firstSol = (xs: Tok[]) => xs.map((x) => firstCreatorAdd(x)![5]).filter((v): v is number => v !== null);
  for (const [name, xs] of [['collapsed', hit], ['not collapsed', miss]] as const) {
    const v = firstSol(xs);
    console.log(`first creator add SOL, ${name}: ${bins.map(([b, t]) => `${b}:${v.filter(t).length}`).join(' ')}; ${dist(v)}`);
  }
  const in85 = (r: TokenFeatures['liq'][number]) => r[1] === 0 && r[5] !== null && r[5] >= 84.9 && r[5] <= 85.1;
  const any85 = withOutcome.filter((x) => x.liq.some(in85));
  const role = (x: Tok) => { const r = x.liq.find(in85)!; return `${r[2] === x.creator ? 'creator' : 'other'} on ${r[4]}`; };
  console.log(`standalone rule "any add of 84.9–85.1 SOL": ${any85.length} tokens, collapsed ${any85.filter(isCollapsed).length} (${pct(any85.filter(isCollapsed).length, any85.length)})`);
  for (const [k, n] of Object.entries(tally(any85, role))) {
    const g = any85.filter((x) => role(x) === k);
    console.log(`  ${k}: ${n} tokens, collapsed ${g.filter(isCollapsed).length} (${pct(g.filter(isCollapsed).length, n)})`);
  }
  const otherProviders = tally(any85.filter((x) => role(x).startsWith('other')), (x) => x.liq.find(in85)![2]);
  console.log('  providers of the "other" 85-SOL adds:', Object.entries(otherProviders).slice(0, 5).map(([w, n]) => `${w.slice(0, 8)}…×${n}`).join(' '));

  // ---------- Q2 sell share
  console.log('\n## Q2 sell share (graduated tokens, swaps while graduated, ≥10 swaps)');
  const variants: [string, (x: Tok) => number | null][] = [
    ['whole capture (as in the 40-min version)', (x) => sellShare(swaps(x))],
    ['only before the collapse', (x) => sellShare(swaps(x).filter((r) => x.collapseAt === null || r[0] < x.collapseAt))],
    ['first 5 min after graduation, before collapse', (x) => (x.gradAt === null ? null : sellShare(swaps(x).filter((r) => r[0] < x.gradAt! + 300 && (x.collapseAt === null || r[0] < x.collapseAt))))],
  ];
  const pools: [string, (x: Tok) => boolean][] = [
    ['all graduated', () => true],
    ['WITHOUT the main signal', (x) => firstCreatorAdd(x) === undefined],
    ['WITH the main signal', (x) => firstCreatorAdd(x) !== undefined],
  ];
  for (const [vname, get] of variants) {
    for (const [pname, inPool] of pools) {
      const g = grads.filter(inPool);
      const a = g.filter(isCollapsed).map(get).filter((v): v is number => v !== null);
      const b = g.filter((x) => !isCollapsed(x)).map(get).filter((v): v is number => v !== null);
      console.log(`${vname} | ${pname} | collapsed n=${a.length} p50 ${fmt(q(a, 0.5))} [${fmt(q(a, 0.25))}–${fmt(q(a, 0.75))}] | not n=${b.length} p50 ${fmt(q(b, 0.5))} [${fmt(q(b, 0.25))}–${fmt(q(b, 0.75))}] | AUC ${fmt(auc(a, b))}`);
    }
  }
  // Redundancy: does sell share predict the main signal itself?
  const early = variants[2]![1];
  const withSig = grads.filter((x) => firstCreatorAdd(x) !== undefined).map(early).filter((v): v is number => v !== null);
  const withoutSig = grads.filter((x) => firstCreatorAdd(x) === undefined).map(early).filter((v): v is number => v !== null);
  console.log(`early sell share, main-signal tokens vs the rest: p50 ${fmt(q(withSig, 0.5))} (n ${withSig.length}) vs ${fmt(q(withoutSig, 0.5))} (n ${withoutSig.length}); AUC (low = signal tokens sell less) ${fmt(auc(withSig, withoutSig))}`);
  for (const cut of [0.1, 0.15, 0.2, 0.25]) {
    const flagged = grads.filter((x) => firstCreatorAdd(x) === undefined).filter((x) => { const v = early(x); return v !== null && v <= cut; });
    console.log(`  rule "early sell share ≤ ${cut}" on tokens WITHOUT the main signal: ${flagged.length} flagged, collapsed ${flagged.filter(isCollapsed).length} (${pct(flagged.filter(isCollapsed).length, flagged.length)})`);
  }
  const traders = (x: Tok) => new Set(swaps(x).map((r) => r[2])).size;
  const a = grads.filter(isCollapsed).map(traders);
  const b = grads.filter((x) => !isCollapsed(x)).map(traders);
  console.log(`distinct traders while graduated: collapsed p50 ${fmt(q(a, 0.5))} vs not ${fmt(q(b, 0.5))}, AUC ${fmt(auc(a, b))}`);

  // ---------- Signal 1 recheck
  const serialTokens = withOutcome.filter((x) => x.creator !== null && (d.creators[x.creator]?.launches ?? 0) > 10);
  console.log(`\n## signal 1 (>10 launches in the capture): ${serialTokens.length} tokens, collapsed ${serialTokens.filter(isCollapsed).length} (${pct(serialTokens.filter(isCollapsed).length, serialTokens.length)}); serial creators ${Object.values(d.creators).filter((c) => c.serial).length}`);
  const serialByShare: Record<string, { creators: number; launches: number; collapses: number }> = {};
  const byCreator = new Map<string, Tok[]>();
  for (const x of withOutcome) if (x.creator !== null) (byCreator.get(x.creator) ?? byCreator.set(x.creator, []).get(x.creator)!).push(x);
  for (const [c, xs] of byCreator) {
    if ((d.creators[c]?.launches ?? 0) <= 10) continue;
    const share = xs.filter(graduated).length / xs.length;
    const k = share === 0 ? '0' : share <= 0.1 ? '(0,0.1]' : share <= 0.5 ? '(0.1,0.5]' : '(0.5,1]';
    const s = (serialByShare[k] ??= { creators: 0, launches: 0, collapses: 0 });
    s.creators += 1;
    s.launches += xs.length;
    s.collapses += xs.filter(isCollapsed).length;
  }
  console.log('serial creators by graduated share', serialByShare);
}

main();
