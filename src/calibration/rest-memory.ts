/**
 * How much heap the REST client's caches hold after a night of dev-history answers.
 *
 * The live answers of the night were not stored, so they are synthesized: the real client, a
 * fake `fetch` returning the real response shape (tests/fixtures/rest-dev.json) with as many
 * tokens as that creator launched in the capture (a lower bound: dev-history also lists older
 * launches, up to 100), in the order and mix the simulated enricher dispatched them
 * (data/calibration/<capture>-memory.json). Heap measured after a forced GC.
 *
 * Usage: node --expose-gc dist/calibration/rest-memory.js 20260926 [--serial-listed 100] [--warm]
 *        (--warm: request mix of the warm-start simulation, <capture>-memory-warm.json)
 *        (--serial-listed: answers of serial creators list that many tokens, as dev-history does
 *         for a creator with ≥ 100 launches in its lifetime)
 */
import { readFileSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { SolamiRestClient } from '../rest/client.js';
import { TokenBucket } from '../rest/token-bucket.js';
import type { CaptureFeatures } from './extract.js';

const MAX_LISTED = 100;

/** In its own scope, so the two big JSON files are garbage before the baseline is measured. */
function inputs(prefix: string) {
  const suffix = process.argv.includes('--warm') ? '-memory-warm' : '-memory';
  const mem = JSON.parse(readFileSync(`data/calibration/${prefix}${suffix}.json`, 'utf8')) as CaptureFeatures;
  const feats = JSON.parse(readFileSync(`data/calibration/${prefix}.json`, 'utf8')) as CaptureFeatures;
  return {
    dispatched: (mem.enrichment as { final: { dispatched: Record<string, number> } }).final.dispatched,
    creators: Object.entries(feats.creators),
  };
}

async function main(): Promise<void> {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc === undefined) throw new Error('needs node --expose-gc');
  const prefix = process.argv[2] ?? '20260926';
  const { dispatched, creators } = inputs(prefix);
  const fixture = JSON.parse(readFileSync('tests/fixtures/rest-dev.json', 'utf8')) as { tokens: Record<string, unknown>[] } & Record<string, unknown>;
  const template = fixture.tokens[0]!;
  const serial = creators.filter(([, c]) => c.serial);
  const flag = process.argv.indexOf('--serial-listed');
  const serialListed = flag === -1 ? null : Number(process.argv[flag + 1]);
  const launchesOf = new Map(creators.map(([c, v]) => [c, Math.min(MAX_LISTED, v.serial && serialListed !== null ? serialListed : Math.max(1, v.launches))]));
  let seq = 0;
  // Base58 has no '0': pad with '1' and map '0' → 'z'. The first 20 chars identify the creator.
  const mintOf = (creator: string, i: number) => `${creator.slice(0, 20)}${String(i).padStart(24, '1').replaceAll('0', 'z')}`;
  const fakeFetch = ((input: string | URL) => {
    const url = new URL(input);
    const creator = url.searchParams.get('address')!.slice(0, 20);
    const n = launchesOf.get(creatorByPrefix.get(creator)!) ?? 1;
    const tokens = Array.from({ length: n }, (_, i) => ({ ...template, mint: mintOf(creatorByPrefix.get(creator)!, i) }));
    seq += 1;
    const body = { ...fixture, mint: url.searchParams.get('address'), creator: creatorByPrefix.get(creator), tokens_launched: n, migrated: 0, scanned: n, tokens };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }) as typeof fetch;
  const creatorByPrefix = new Map(creators.map(([c]) => [c.slice(0, 20), c]));

  const config = loadConfig();
  const client = new SolamiRestClient({
    ...config.rest, apiKey: 'synthetic',
    bucket: new TokenBucket({ capacity: 1e9, refillPerSecond: 1e9, maxQueue: 1e9 }),
    fetch: fakeFetch,
  });
  // Let pending promises and response bodies settle, then collect twice: one gc() right after
  // the requests still saw them alive (a first version reported a heap that shrank over time).
  const settledHeap = async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    gc();
    gc();
    return process.memoryUsage().heapUsed;
  };
  const base = await settledHeap();
  // Entry counts, read through the private fields (measurement only).
  const counts = () => {
    const c = client as unknown as { identities: { size: number }; histories: { size: number }; liquidity: { byMint: { size: number; entries: Map<string, { value: unknown[] }> } } };
    let readings = 0;
    for (const e of c.liquidity.byMint.entries.values()) readings += e.value.length;
    return `identities ${c.identities.size}, histories ${c.histories.size}, liquidity mints ${c.liquidity.byMint.size}, readings ${readings}`;
  };
  // First-time creators (new-creator + graduation + known-creator), then the suspect re-polls.
  const firstTime = dispatched['new-creator']! + dispatched.graduation! + dispatched['known-creator']!;
  const order = creators.map(([c]) => c);
  const checkpoints = new Set([5000, 10000, 20000, firstTime]);
  for (let i = 0; i < firstTime; i += 1) {
    const c = order[i % order.length]!;
    // A distinct mint per request so the history cache never answers (as live: each dispatch is a miss).
    await client.getCreatorHistory(mintOf(c, 900 + Math.floor(i / order.length)));
    if (checkpoints.has(i + 1)) {
      console.log(`after ${i + 1} first-time requests: REST caches ${(((await settledHeap()) - base) / 1e6).toFixed(0)} MB; ${counts()}`);
    }
  }
  for (let i = 0; i < dispatched.suspect!; i += 1) {
    const [c] = serial[i % serial.length]!;
    await client.getCreatorHistory(mintOf(c, 5000 + i));
  }
  console.log(`after + ${dispatched.suspect} suspect re-polls (${serial.length} serial creators): REST caches ${(((await settledHeap()) - base) / 1e6).toFixed(0)} MB; ${counts()}; synthetic responses ${seq}`);
  console.log('launches per creator (capped at 100) used as tokens per answer: mean', (order.reduce((s, c) => s + launchesOf.get(c)!, 0) / order.length).toFixed(2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
