/**
 * One capture of `data/live/` replayed in (approximate) time order, for offline analysis.
 *
 * Why not ReplaySource over the directory: the persister writes two tiers to separate files
 * (lifecycle ~1 h each, firehose ~2 min each). Read one after the other, every swap of a token
 * arrives hours after its token was created (or before), and the store drops swaps of tokens it
 * no longer (or not yet) follows. With 40 min of swaps that barely mattered; with a whole night it
 * decides the result. Here both tiers are merged line by line on `block_time`.
 *
 * Speed: 99 % of the firehose is about tokens that never appear in the lifecycle tier. A swap
 * line is parsed only if its `mint` or `quote_mint` is one the lifecycle tier ever mentions (a
 * superset of what the store can track, so the store sees exactly the swaps it would keep live).
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { systemClock } from '../core/time.js';
import type { SolamiEvent } from '../events/types.js';
import { readJsonlLines } from '../ingest/replay-source.js';
import { FrameProcessor } from '../ingest/source.js';

const MINT_KEYS = /"(?:mint|base_mint|quote_mint)":"(\w+)"/g;
const MINT = /"mint":"(\w+)"/;
const STARTS_TRACKING = /"type":"(?:token_create|meme|graduation)"/;
const BLOCK_TIME = /"block_time":(\d+)/;
const SOL = 'So11111111111111111111111111111111111111112';

export { CURVE_DEXES } from '../state/token-state.js';

export interface Capture {
  readonly lifecycle: readonly string[];
  readonly firehose: readonly string[];
}

/** Files of the capture whose name stamp starts with `prefix` (e.g. "20260926"). */
export function captureFiles(dir: string, prefix: string): Capture {
  const names = readdirSync(dir).sort();
  const pick = (tier: string) => names.filter((n) => n.startsWith(`${tier}-${prefix}`) && n.endsWith('.jsonl')).map((n) => join(dir, n));
  return { lifecycle: pick('lifecycle'), firehose: pick('firehose') };
}

/**
 * Every mint the store could follow: only token_create, meme and graduation start tracking a
 * token (liquidity/pool_create wait for one of those). Liquidity events of big pools (USDC…)
 * must not enter the set, or the prefilter lets the whole firehose through.
 */
export async function lifecycleMints(capture: Capture): Promise<Set<string>> {
  const mints = new Set<string>();
  for (const file of capture.lifecycle) {
    for await (const line of readJsonlLines(file)) {
      if (!STARTS_TRACKING.test(line)) continue;
      const m = MINT.exec(line);
      // A regex match is a slice that keeps its whole source chunk alive (~800 MB for this set): copy it.
      if (m?.[1] !== undefined && m[1] !== SOL) mints.add(Buffer.from(m[1], 'latin1').toString('latin1'));
    }
  }
  return mints;
}

interface Cursor {
  readonly lines: AsyncGenerator<string>;
  line: string | null;
  key: number;
}

async function* linesOf(files: readonly string[], keep: (line: string) => boolean): AsyncGenerator<string> {
  for (const file of files) for await (const line of readJsonlLines(file)) if (line.trim() !== '' && keep(line)) yield line;
}

async function advance(c: Cursor): Promise<void> {
  const next = await c.lines.next();
  c.line = next.done === true ? null : next.value;
  if (c.line === null) return;
  const t = BLOCK_TIME.exec(c.line);
  if (t?.[1] !== undefined) c.key = Number(t[1]); // lines without block_time (meme…) keep the stream's last key
}

export interface MergedReplay {
  readonly processor: FrameProcessor;
  readonly skippedSwapLines: () => number;
  events(): AsyncGenerator<SolamiEvent>;
}

export function mergedReplay(capture: Capture, mints: ReadonlySet<string>, dedupWindowPerType: number): MergedReplay {
  const processor = new FrameProcessor(dedupWindowPerType, systemClock, () => {});
  let skipped = 0;
  const relevant = (line: string) => {
    for (const m of line.matchAll(MINT_KEYS)) if (m[1] !== undefined && mints.has(m[1])) return true;
    skipped += 1;
    return false;
  };
  return {
    processor,
    skippedSwapLines: () => skipped,
    async *events() {
      const cursors: Cursor[] = [
        { lines: linesOf(capture.lifecycle, () => true), line: null, key: 0 },
        { lines: linesOf(capture.firehose, relevant), line: null, key: 0 },
      ];
      for (const c of cursors) await advance(c);
      for (;;) {
        const live = cursors.filter((c) => c.line !== null);
        if (live.length === 0) return;
        const c = live.reduce((a, b) => (b.key < a.key ? b : a));
        const event = processor.process(c.line!);
        await advance(c);
        if (event === null) continue;
        processor.counters(event.type).delivered += 1;
        yield event;
      }
    },
  };
}
