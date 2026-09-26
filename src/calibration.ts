/**
 * Calibration analysis before the phase-4 detector (docs/ANALISIS_calibracion.md).
 *
 * Replays captures through the SAME pipeline and collapse definition as `analyze.ts`
 * (lifecycle files first, then firehose files: the order that produced the 814 collapses),
 * and collects per-token features from the normalized events. Prints tables; decides nothing.
 *
 * Usage: node dist/calibration.js            (stream only)
 *        node --env-file=.env dist/calibration.js --rest   (+ dev-history sample, ~1 req/s)
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Decimal } from 'decimal.js';
import { loadConfig } from './config.js';
import { secondsValue } from './core/time.js';
import type { SolamiEvent } from './events/types.js';
import { createReplaySource } from './ingest/factory.js';
import { createRestClient, createStateStore } from './state/factory.js';
import { currentLiquidityUsd, outcomeOf } from './state/token-state.js';
import type { TokenOutcome } from './state/types.js';

const DIR = 'data/live';
const SOL = 'So11111111111111111111111111111111111111112';
const HAD = new Decimal(1000);
const LOW = new Decimal(5);
const ORIGINAL_OPERATORS: Record<string, string> = {
  BpxbkXawVYwVMrm8kaqrcG1bfwkHimRza5wv6igrid1R: 'E8aRQphjPgCXFXRe3to9AQLPzD5fueRaMR7C9jxM1V6u',
  '95kdrk4mygiHrTcpEkfNuvgxNMpDfTkuxtS6VZHJN4j9': 'h56ZSovFgZ44325MGv22sAxr8QmoY9kNuVgoTRuL25i',
};

interface Features {
  creator: string | null;
  createdAt: number | null;
  launchpad: string | null;
  name: string | null;
  gradAt: number | null;
  gradDex: string | null;
  pools: Set<string>;
  liqAdds: number;
  liqRemoves: number;
  removers: Set<string>;
  /** Liquidity ADDs by the token's own creator: SOL added (null if the quote is not SOL). */
  creatorAdds: { sol: number | null; dex: string; at: number }[];
  memeTrades1h: number;
  memeBuys1h: number;
  memeSells1h: number;
  swaps: number;
  traders: Set<string>;
  swapBuys: number;
  swapSells: number;
  firstSwap: number | null;
  collapseAt: number | null;
  collapseBy: string | null;
  collapseActor: string | null;
}

const features = new Map<string, Features>();
function f(mint: string): Features {
  let x = features.get(mint);
  if (x === undefined) {
    x = {
      creator: null, createdAt: null, launchpad: null, name: null, gradAt: null, gradDex: null, pools: new Set(),
      liqAdds: 0, liqRemoves: 0, removers: new Set(), creatorAdds: [], memeTrades1h: 0, memeBuys1h: 0, memeSells1h: 0,
      swaps: 0, traders: new Set(), swapBuys: 0, swapSells: 0, firstSwap: null, collapseAt: null, collapseBy: null, collapseActor: null,
    };
    features.set(mint, x);
  }
  return x;
}

function collect(e: SolamiEvent, tracked: (mint: string) => boolean): string | null {
  switch (e.type) {
    case 'token_create': {
      const x = f(e.mint);
      x.creator = e.creator;
      x.createdAt = secondsValue(e.blockTime);
      x.launchpad = e.dex;
      x.name = e.name.trim().toLowerCase();
      return e.mint;
    }
    case 'graduation': {
      const x = f(e.mint);
      x.creator ??= e.creator;
      if (x.gradAt === null || secondsValue(e.blockTime) < x.gradAt) x.gradAt = secondsValue(e.blockTime);
      x.gradDex = e.dex;
      x.pools.add(e.pool);
      return e.mint;
    }
    case 'meme': {
      if (!features.has(e.mint)) return null;
      const w = e.windows.find((win) => win.windowSeconds === 3600);
      const x = f(e.mint);
      if (w !== undefined && w.trades > x.memeTrades1h) {
        x.memeTrades1h = w.trades;
        x.memeBuys1h = w.buys;
        x.memeSells1h = w.sells;
      }
      return e.mint;
    }
    case 'liquidity': {
      const mint = tracked(e.baseMint) ? e.baseMint : tracked(e.quoteMint) ? e.quoteMint : null;
      if (mint === null) return null;
      const x = f(mint);
      x.pools.add(e.pool);
      if (e.kind === 'add') {
        x.liqAdds += 1;
        if (x.creator !== null && e.provider === x.creator) {
          const sol = mint === e.baseMint && e.quoteMint === SOL ? Number(e.quoteAmount) / 1e9 : null;
          x.creatorAdds.push({ sol, dex: e.dex, at: secondsValue(e.blockTime) });
        }
      } else {
        x.liqRemoves += 1;
        x.removers.add(e.provider);
      }
      return mint;
    }
    case 'swap': {
      const mint = tracked(e.mint) ? e.mint : tracked(e.quoteMint) ? e.quoteMint : null;
      if (mint === null) return null;
      const x = f(mint);
      x.swaps += 1;
      x.traders.add(e.trader);
      // side is from the `mint` leg's point of view
      const buy = (e.side === 'buy') === (mint === e.mint);
      if (buy) x.swapBuys += 1;
      else x.swapSells += 1;
      const t = secondsValue(e.blockTime);
      if (x.firstSwap === null || t < x.firstSwap) x.firstSwap = t;
      return mint;
    }
    default:
      return null;
  }
}

// ---------- statistics helpers ----------
const q = (xs: number[], p: number) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const fmt = (v: number) => (Number.isNaN(v) ? '–' : Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2));
/** AUC = P(value of a random collapsed token > value of a random non-collapsed one); ties count half. */
function auc(pos: number[], neg: number[]): number {
  if (pos.length === 0 || neg.length === 0) return NaN;
  const all = [...pos.map((v) => ({ v, p: 1 })), ...neg.map((v) => ({ v, p: 0 }))].sort((a, b) => a.v - b.v);
  let rankSum = 0;
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j < all.length && all[j]!.v === all[i]!.v) j += 1;
    const avgRank = (i + j + 1) / 2;
    for (let k = i; k < j; k += 1) if (all[k]!.p === 1) rankSum += avgRank;
    i = j;
  }
  return (rankSum - (pos.length * (pos.length + 1)) / 2) / (pos.length * neg.length);
}
const bucket = (n: number) => (n <= 1 ? '1' : n === 2 ? '2' : n <= 10 ? '3-10' : '>10');
const pct = (a: number, b: number) => (b === 0 ? '–' : `${((100 * a) / b).toFixed(1)}%`);

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
  const config = loadConfig();
  const names = readdirSync(DIR).sort();
  const files = [...names.filter((n) => n.startsWith('lifecycle-')), ...names.filter((n) => n.startsWith('firehose-'))].map((n) => join(DIR, n));
  const source = createReplaySource(config, files);
  const store = createStateStore(config);
  let firehoseStart = Infinity;
  let end = 0;
  for await (const e of source.events()) {
    store.apply(e);
    const mint = collect(e, (m) => store.tokens.has(m));
    if (e.type === 'swap') firehoseStart = Math.min(firehoseStart, secondsValue(e.blockTime));
    if ('blockTime' in e && e.type !== 'swap') end = Math.max(end, secondsValue(e.blockTime));
    if (mint === null || (e.type !== 'liquidity' && e.type !== 'swap')) continue;
    const token = store.token(mint);
    const x = features.get(mint);
    if (token === undefined || x === undefined || x.collapseAt !== null) continue;
    const now = currentLiquidityUsd(token);
    if (token.peakLiquidityUsd?.gte(HAD) && now !== null && now.lte(LOW)) {
      x.collapseAt = secondsValue(e.blockTime);
      x.collapseBy = e.type === 'liquidity' ? `liquidity ${e.kind}` : 'swap';
      x.collapseActor = e.type === 'liquidity' ? e.provider : e.trader;
    }
  }

  // Final outcomes, exactly as analyze.ts.
  const outcomes = new Map<string, { creator: string | null; outcome: TokenOutcome }>();
  for (const c of store.creators.values()) {
    for (const l of c.launches.values()) if (l.outcome !== null) outcomes.set(l.mint, { creator: c.creator, outcome: l.outcome });
  }
  for (const t of store.tokens.values()) outcomes.set(t.mint, { creator: t.creator, outcome: outcomeOf(t) });
  const isCollapsed = (o: TokenOutcome) =>
    o.peakLiquidityUsd !== null && o.peakLiquidityUsd.gte(HAD) && o.lastLiquidityUsd !== null && o.lastLiquidityUsd.lte(LOW);
  const launches = (creator: string | null) => (creator === null ? 0 : (store.creator(creator)?.launches.size ?? 0));
  const serial = new Set([...store.creators.values()].filter((c) => c.serial).map((c) => c.creator));

  const collapsed = [...outcomes].filter(([, v]) => isCollapsed(v.outcome));
  const graduated = [...outcomes].filter(([, v]) => v.outcome.stage === 'graduated');
  console.log(`firehose (swaps) window: ${new Date(firehoseStart * 1000).toISOString()} → ${new Date(end * 1000).toISOString()}`);
  console.log(`collapsed ${collapsed.length}; of them graduated ${collapsed.filter(([, v]) => v.outcome.stage === 'graduated').length}; graduated total ${graduated.length}`);

  // ---- Q1
  console.log('\n## Q1 launches (in the capture) of the creators of collapsed tokens');
  const byBucketTokens: Record<string, number> = {};
  const creatorsOfCollapsed = new Map<string, number>();
  let unknownCreator = 0;
  for (const [, v] of collapsed) {
    if (v.creator === null) {
      unknownCreator += 1;
      continue;
    }
    creatorsOfCollapsed.set(v.creator, (creatorsOfCollapsed.get(v.creator) ?? 0) + 1);
    const b = bucket(launches(v.creator));
    byBucketTokens[b] = (byBucketTokens[b] ?? 0) + 1;
  }
  const byBucketCreators: Record<string, number> = {};
  for (const c of creatorsOfCollapsed.keys()) byBucketCreators[bucket(launches(c))] = (byBucketCreators[bucket(launches(c))] ?? 0) + 1;
  console.log('tokens by creator bucket', byBucketTokens, 'unknown creator', unknownCreator);
  console.log('creators by bucket', byBucketCreators, 'distinct creators', creatorsOfCollapsed.size);
  const multi = [...creatorsOfCollapsed.values()];
  console.log('collapses per creator: 1 →', multi.filter((n) => n === 1).length, '| 2 →', multi.filter((n) => n === 2).length, '| ≥3 →', multi.filter((n) => n >= 3).length, 'max', Math.max(...multi));
  const withoutCreate = collapsed.filter(([m]) => features.get(m)?.createdAt == null).length;
  console.log('collapsed tokens whose token_create was not in the capture:', withoutCreate);

  // ---- Q2
  console.log('\n## Q2 serial creators vs creators with a collapse');
  const both = [...creatorsOfCollapsed.keys()].filter((c) => serial.has(c));
  console.log(`serial ${serial.size}; with collapse ${creatorsOfCollapsed.size}; both ${both.length}; only serial ${serial.size - both.length}; only collapse ${creatorsOfCollapsed.size - both.length}`);
  const collapsedBySerial = collapsed.filter(([, v]) => v.creator !== null && serial.has(v.creator)).length;
  console.log(`collapsed tokens by serial creators ${collapsedBySerial} / ${collapsed.length}`);
  for (const c of both) {
    const cs = store.creator(c)!;
    const grads = [...cs.launches.keys()].filter((m) => outcomes.get(m)?.outcome.stage === 'graduated').length;
    console.log(`  both: ${c} launches ${cs.launches.size} graduated ${grads} collapsed ${creatorsOfCollapsed.get(c)}`);
  }
  // damage proxy: quote-side liquidity lost (peak - last)
  let dmgAll = new Decimal(0);
  const dmgBy: Record<string, Decimal> = {};
  for (const [, v] of collapsed) {
    const lost = v.outcome.peakLiquidityUsd!.sub(v.outcome.lastLiquidityUsd!);
    dmgAll = dmgAll.add(lost);
    const b = v.creator === null ? 'unknown' : bucket(launches(v.creator));
    dmgBy[b] = (dmgBy[b] ?? new Decimal(0)).add(lost);
  }
  console.log(`damage proxy total $${dmgAll.toFixed(0)}`, Object.fromEntries(Object.entries(dmgBy).map(([k, d]) => [k, `$${d.toFixed(0)} (${pct(d.toNumber(), dmgAll.toNumber())})`])));

  // ---- Q3 graduated: collapsed vs not
  console.log('\n## Q3 graduated tokens: collapsed vs not');
  const pos = graduated.filter(([, v]) => isCollapsed(v.outcome));
  const neg = graduated.filter(([, v]) => !isCollapsed(v.outcome));
  console.log(`collapsed ${pos.length}, not ${neg.length}`);
  const numeric: [string, (m: string, o: TokenOutcome) => number | null][] = [
    ['create→graduation s', (m) => { const x = features.get(m); return x?.createdAt != null && x.gradAt != null ? x.gradAt - x.createdAt : null; }],
    ['peak liquidity $', (_m, o) => o.peakLiquidityUsd?.toNumber() ?? null],
    ['pools', (m) => features.get(m)?.pools.size ?? null],
    ['liquidity adds', (m) => features.get(m)?.liqAdds ?? null],
    ['liquidity removes', (m) => features.get(m)?.liqRemoves ?? null],
    ['curve trades (1h window max)', (m) => features.get(m)?.memeTrades1h ?? null],
    ['curve sells/trades (1h)', (m) => { const x = features.get(m); return x && x.memeTrades1h > 0 ? x.memeSells1h / x.memeTrades1h : null; }],
    ['creator launches in capture', (m) => launches(features.get(m)?.creator ?? outcomes.get(m)?.creator ?? null)],
  ];
  console.log('feature | n(col) | n(not) | median col [p25–p75] | median not [p25–p75] | AUC');
  for (const [name, get] of numeric) {
    const a = pos.map(([m, v]) => get(m, v.outcome)).filter((v): v is number => v !== null);
    const b = neg.map(([m, v]) => get(m, v.outcome)).filter((v): v is number => v !== null);
    console.log(`${name} | ${a.length} | ${b.length} | ${fmt(q(a, 0.5))} [${fmt(q(a, 0.25))}–${fmt(q(a, 0.75))}] | ${fmt(q(b, 0.5))} [${fmt(q(b, 0.25))}–${fmt(q(b, 0.75))}] | ${fmt(auc(a, b))}`);
  }
  const categorical: [string, (m: string) => string][] = [
    ['launchpad', (m) => features.get(m)?.launchpad ?? 'unknown (no token_create)'],
    ['graduation dex', (m) => features.get(m)?.gradDex ?? 'unknown'],
    ['remover is the creator', (m) => { const x = features.get(m); return x === undefined || x.removers.size === 0 ? 'no remove seen' : x.creator !== null && x.removers.has(x.creator) ? 'yes' : 'no'; }],
  ];
  for (const [name, get] of categorical) {
    const counts: Record<string, [number, number]> = {};
    for (const [m] of pos) (counts[get(m)] ??= [0, 0])[0] += 1;
    for (const [m] of neg) (counts[get(m)] ??= [0, 0])[1] += 1;
    console.log(`${name}: ` + Object.entries(counts).map(([k, [c, n]]) => `${k}: ${c}/${c + n} collapse (${pct(c, c + n)})`).join(' · '));
  }
  // How the collapse happened
  const how: Record<string, number> = {};
  const delay: number[] = [];
  for (const [m] of pos) {
    const x = features.get(m);
    how[x?.collapseBy ?? 'not observed'] = (how[x?.collapseBy ?? 'not observed'] ?? 0) + 1;
    if (x?.collapseAt != null && x.gradAt != null) delay.push(x.collapseAt - x.gradAt);
  }
  console.log('collapse mechanism', how, `graduation→collapse s: p25 ${fmt(q(delay, 0.25))} p50 ${fmt(q(delay, 0.5))} p75 ${fmt(q(delay, 0.75))} p90 ${fmt(q(delay, 0.9))} (n ${delay.length})`);

  // Operator clustering: the wallet that removed the liquidity, across creators
  const actorCreators = new Map<string, Set<string>>();
  const actorTokens = new Map<string, number>();
  for (const [m, v] of pos) {
    const x = features.get(m);
    if (x?.collapseActor == null || x.collapseBy === 'swap') continue;
    (actorCreators.get(x.collapseActor) ?? actorCreators.set(x.collapseActor, new Set()).get(x.collapseActor)!).add(v.creator ?? '?');
    actorTokens.set(x.collapseActor, (actorTokens.get(x.collapseActor) ?? 0) + 1);
  }
  const actors = [...actorTokens.entries()].sort((a, b) => b[1] - a[1]);
  const byRemoval = pos.filter(([m]) => features.get(m)?.collapseBy?.startsWith('liquidity')).length;
  console.log(`collapses by liquidity remove ${byRemoval}; distinct removing wallets ${actors.length}; wallets removing ≥2 tokens ${actors.filter(([, n]) => n >= 2).length} covering ${actors.filter(([, n]) => n >= 2).reduce((s, [, n]) => s + n, 0)} tokens`);
  for (const [a, n] of actors.slice(0, 10)) console.log(`  remover ${a}: ${n} tokens of ${actorCreators.get(a)!.size} distinct creators; is a creator itself: ${store.creator(a) !== undefined}`);
  // Same name reused across collapsed tokens of different creators
  const byName = new Map<string, Set<string>>();
  for (const [m, v] of pos) { const n = features.get(m)?.name; if (n) (byName.get(n) ?? byName.set(n, new Set()).get(n)!).add(v.creator ?? '?'); }
  const reused = [...byName.entries()].filter(([, s]) => s.size >= 2);
  console.log(`collapsed-token names reused by ≥2 creators: ${reused.length} names, ${reused.reduce((s, [, c]) => s + c.size, 0)} creators`, reused.slice(0, 5).map(([n, s]) => `${n}×${s.size}`));
  // Final liquidity values of collapsed tokens (signal 3 material)
  const finals = pos.map(([, v]) => v.outcome.lastLiquidityUsd!.toNumber());
  console.log(`final stream liquidity of collapsed: p10 ${fmt(q(finals, 0.1))} p50 ${fmt(q(finals, 0.5))} p90 ${fmt(q(finals, 0.9))}; exactly 0: ${finals.filter((v) => v === 0).length}`);

  // ---- Pre-collapse signature: what is observable BEFORE the drain
  console.log('\n## Signature observable before the collapse (all tokens with an outcome)');
  const all = [...outcomes];
  const stageOf = (o: TokenOutcome) => o.stage;
  const breakdown: Record<string, number> = {};
  for (const [m, v] of collapsed) {
    const k = `${stageOf(v.outcome)} / ${features.get(m)?.launchpad ?? '?'}`;
    breakdown[k] = (breakdown[k] ?? 0) + 1;
  }
  console.log('collapsed by stage / launchpad', breakdown);
  const addedBeforeCollapse = (m: string) => {
    const x = features.get(m);
    if (x === undefined) return false;
    return x.creatorAdds.some((a) => x.collapseAt === null || a.at <= x.collapseAt);
  };
  const rules: [string, (m: string) => boolean][] = [
    ['creator adds liquidity himself (before any collapse)', addedBeforeCollapse],
    ['… and on a pumpswap pool', (m) => addedBeforeCollapse(m) && (features.get(m)?.creatorAdds.some((a) => a.dex === 'pumpswap') ?? false)],
    ['launchpad meteora_dbc', (m) => features.get(m)?.launchpad === 'meteora_dbc'],
    ['created and graduated in the same second', (m) => { const x = features.get(m); return x?.createdAt != null && x.gradAt === x.createdAt; }],
    ['creator launched ≤ 2 tokens in the capture', (m) => launches(features.get(m)?.creator ?? null) <= 2],
    ['creator launched > 10 tokens (signal 1)', (m) => launches(features.get(m)?.creator ?? null) > 10],
  ];
  console.log('rule | tokens matching | of them collapsed (precision) | collapsed covered (recall of 814)');
  for (const [name, rule] of rules) {
    const matching = all.filter(([m]) => rule(m));
    const hit = matching.filter(([, v]) => isCollapsed(v.outcome)).length;
    console.log(`${name} | ${matching.length} | ${hit} (${pct(hit, matching.length)}) | ${pct(hit, collapsed.length)}`);
  }
  const amounts = (group: [string, { outcome: TokenOutcome }][]) =>
    group.flatMap(([m]) => features.get(m)?.creatorAdds.map((a) => a.sol).filter((v): v is number => v !== null).slice(0, 1) ?? []);
  const colAdds = amounts(collapsed);
  const notAdds = amounts(all.filter(([, v]) => !isCollapsed(v.outcome)));
  const bins: [string, (v: number) => boolean][] = [
    ['<80', (v) => v < 80], ['80–84.9', (v) => v >= 80 && v < 84.9], ['84.9–85.1', (v) => v >= 84.9 && v <= 85.1], ['85.1–90', (v) => v > 85.1 && v <= 90], ['>90', (v) => v > 90],
  ];
  console.log(`first creator add (SOL): collapsed n=${colAdds.length}`, bins.map(([b, t]) => `${b}:${colAdds.filter(t).length}`).join(' '),
    `| not collapsed n=${notAdds.length}`, bins.map(([b, t]) => `${b}:${notAdds.filter(t).length}`).join(' '));
  // name reuse baseline
  const reuseRate = (group: [string, { creator: string | null }][]) => {
    const names = new Map<string, Set<string>>();
    for (const [m, v] of group) { const n = features.get(m)?.name; if (n) (names.get(n) ?? names.set(n, new Set()).get(n)!).add(v.creator ?? '?'); }
    const tokensWithReused = group.filter(([m]) => { const n = features.get(m)?.name; return n !== undefined && n !== null && (names.get(n)?.size ?? 0) >= 2; }).length;
    return `${tokensWithReused}/${group.length} (${pct(tokensWithReused, group.length)})`;
  };
  console.log(`tokens whose name is shared with another creator in the same group: collapsed ${reuseRate(collapsed)} · graduated not collapsed ${reuseRate(neg)}`);

  const cross: Record<string, number> = {};
  for (const [m, v] of collapsed) {
    const k = `${v.outcome.stage}/${features.get(m)?.launchpad ?? '?'} · creator-add ${addedBeforeCollapse(m) ? 'yes' : 'no'}`;
    cross[k] = (cross[k] ?? 0) + 1;
  }
  console.log('collapsed: stage/launchpad × creator adds liquidity', cross);
  // Serial creators by share of launches that graduated (the originating pattern graduates ~all)
  console.log('serial creators: graduated/launched | creators | their launches | their stream collapses');
  const shareBins: [string, (r: number) => boolean][] = [['0', (r) => r === 0], ['(0,0.1]', (r) => r > 0 && r <= 0.1], ['(0.1,0.5]', (r) => r > 0.1 && r <= 0.5], ['(0.5,1]', (r) => r > 0.5]];
  for (const [label, test] of shareBins) {
    const group = [...serial].map((c) => store.creator(c)!).filter((c) => {
      const g = [...c.launches.keys()].filter((m) => outcomes.get(m)?.outcome.stage === 'graduated').length;
      return test(g / c.launches.size);
    });
    const ls = group.reduce((a, c) => a + c.launches.size, 0);
    const cs = group.reduce((a, c) => a + [...c.launches.keys()].filter((m) => { const o = outcomes.get(m)?.outcome; return o !== undefined && isCollapsed(o); }).length, 0);
    console.log(`${label} | ${group.length} | ${ls} | ${cs}${label === '(0.5,1]' ? ' ← ' + group.map((c) => c.creator.slice(0, 6)).join(',') : ''}`);
  }

  // Swap pattern: only tokens that graduated inside the firehose window
  const inWindow = graduated.filter(([m]) => { const x = features.get(m); return x?.gradAt != null && x.gradAt >= firehoseStart; });
  const wp = inWindow.filter(([, v]) => isCollapsed(v.outcome));
  const wn = inWindow.filter(([, v]) => !isCollapsed(v.outcome));
  console.log(`\nswap features (graduated inside the ${((end - firehoseStart) / 60).toFixed(0)}-min firehose window): collapsed ${wp.length}, not ${wn.length}`);
  const swapFeatures: [string, (x: Features) => number | null][] = [
    ['swaps', (x) => x.swaps],
    ['distinct traders', (x) => x.traders.size],
    ['trades per trader', (x) => (x.traders.size ? x.swaps / x.traders.size : null)],
    ['sell share', (x) => (x.swaps ? x.swapSells / x.swaps : null)],
  ];
  for (const [name, get] of swapFeatures) {
    const a = wp.map(([m]) => get(features.get(m)!)).filter((v): v is number => v !== null);
    const b = wn.map(([m]) => get(features.get(m)!)).filter((v): v is number => v !== null);
    console.log(`${name} | ${a.length} | ${b.length} | ${fmt(q(a, 0.5))} [${fmt(q(a, 0.25))}–${fmt(q(a, 0.75))}] | ${fmt(q(b, 0.5))} [${fmt(q(b, 0.25))}–${fmt(q(b, 0.75))}] | AUC ${fmt(auc(a, b))}`);
  }

  // ---- Q4/Q5 dev-history
  if (!process.argv.includes('--rest')) return;
  const client = createRestClient(config);
  const captureStart = Math.min(...[...features.values()].map((x) => x.createdAt ?? Infinity));
  const pick = (list: [string, { creator: string | null }][], n: number, seed: number) => {
    const seen = new Set<string>();
    const out: [string, string][] = [];
    for (const [m, v] of seededShuffle(list.filter(([, v]) => v.creator !== null), seed)) {
      if (seen.has(v.creator!)) continue;
      seen.add(v.creator!);
      out.push([m, v.creator!]);
      if (out.length === n) break;
    }
    return out;
  };
  const groups: [string, [string, string][]][] = [
    ['collapsed', pick(pos, 30, 7)],
    ['control (graduated, not collapsed)', pick(neg, 20, 11)],
    ['original operators', Object.entries(ORIGINAL_OPERATORS).map(([c, m]) => [m, c])],
  ];
  console.log(`\n## Q4 dev-history (capture starts ${new Date(captureStart * 1000).toISOString()})`);
  console.log('group | creator | stream launches | tokens_launched | migrated | before capture | first_launch | tokens ≤$5 now | queried token: bundlers, holders, liquidity_usd, ath_mcap');
  for (const [group, sample] of groups) {
    for (const [mint, creator] of sample) {
      try {
        const h = await client.getCreatorHistory(mint);
        const before = h.tokens.filter((t) => secondsValue(t.createdTime) < captureStart).length;
        const low = h.tokens.filter((t) => t.liquidityUsd.lte(LOW)).length;
        const t = h.tokens.find((x) => x.mint === mint);
        console.log(
          `${group} | ${creator} | ${launches(creator)} | ${h.tokensLaunched} | ${h.migrated} | ${before}${h.truncated ? ' (truncated)' : ''} | ${new Date(secondsValue(h.firstLaunch) * 1000).toISOString()} | ${low}/${h.tokens.length} | ` +
            (t ? `${t.bundlersCount}, ${t.holders}, ${t.liquidityUsd.toFixed(2)}, ${t.athMcapUsd?.toFixed(0) ?? 'null'}` : 'not listed'),
        );
      } catch (error) {
        console.log(`${group} | ${creator} | ERROR ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
