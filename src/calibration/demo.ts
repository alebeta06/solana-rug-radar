/**
 * Builds the bundled demo capture (`samples/demo-20260926.jsonl.gz`): EVERY raw frame of a
 * handful of tokens of the 2026-09-26 night, in the same interleaved order the phase-4 validation
 * replayed them (both tiers merged on `block_time`). A jury without an API key replays it through
 * the real pipeline and the real detector; `tests/detector/demo.test.ts` checks it reproduces the
 * validation's records for these tokens.
 *
 * The selection shows the limits, not only the hits (13:28–15:10 UTC):
 * - red alerts confirmed by a creator-pull (84.99 SOL), including a short 86 s lead;
 * - creator 6RoKmK: a dev dump the detector cannot see coming → amber on its next token, drained
 *   → amber on the one after, NOT drained;
 * - creator 8op9Ai: dev dump not seen → amber on the next token, drained 68 s later;
 * - creator GRiHgT: migration pull not seen → amber on the next token, drained.
 * Whole tokens only: a token cut in half would not reproduce its records. The one cut is the
 * recording's END, the same for every token (`END`, after the last rug and after the failed
 * amber's 60 min): later frames are post-drain trading that changes no record.
 *
 * Left out on purpose: the night's real red failures (the creator added ~0.01 SOL). They are
 * healthy, busy tokens (20–30k swaps over hours, which is why they are not rugs): one alone
 * would double the file and add 80 min of nothing before the first alert.
 *
 * Usage: node dist/calibration/demo.js   (reads data/live, writes samples/)
 */
import { createWriteStream, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import { redactSecrets } from '../core/schema.js';
import { readJsonlLines } from '../ingest/replay-source.js';

export const DEMO_MINTS: readonly string[] = [
  // red → creator-pull
  '7bNueUQTmVagnov88Pj5CUY4mVN3izSuyxQbd87Fmoon',
  'BjcuNML6Ymu4Umn8niDrx1zfVJd2yqFnUUpEtiAn1SSi',
  'Fi2mEFbQdcYoSLQgv6XB9AitdZvNe71HPwmoQG1o7RoL',
  'JiAxUkiE15oqMYeckiTqrVH3DqpF5Zot5nHcYyFcpso',
  'FZX8g3uKvWAHAVcqxd8CU8pkS9dav1V2QHXfy2zfNi5t',
  '2a4SZmHF9aXBCUVzqXp1RMhqCxzmdwrdsbL6S63Vfour',
  'B2ZRWKYcSXhjowAXvm8QHatSTTSejd8UDr7W3XVH6svd',
  '7sGBPoiQyxybw6TC7PuRgco4fi36nk4zvZB9ny1Cfour',
  'G8tLxmkadfFDyrPZebvGYucNzXcmn8qiNuzoYJsdNYeY',
  '4SxaNZYLKrwAGkFoobfFVrub8wRfQapciKLSccrXoKFi',
  // creator 6RoKmK: unseen dev dump → amber drained → amber not drained
  '9F8fWC1DaUprEDiQckD8UHncBQKG1azudu9dxTWCnPbM',
  'FMbbdNJNykhRR7TR5BkFZUxjBHNNRR7QbP6BeReA8bQG',
  'GbKawFenQ2VES6UyMRKPYHJ3KQgd6BssLzjUeXcC3Hzx',
  // creator 8op9Ai: unseen dev dump → amber drained
  'CgqM4NtkPU8xuHytmZzPYSsY4zYkWYdjfFVjv6f4BJvg',
  'Cwa9hYKgX7mEcvFRCjFfHV4YSYhFKYCWxLNwSU6cVmUu',
  // creator GRiHgT: unseen migration pull → amber drained
  'Gf9hX5c6E2k78kmMuvB8qc5hWMEyXTrnJ8GwRVpeHfv9',
  '9zSsWtdEJ3FTqziW14HvdTDa7wAZtCzZ6d5AZ65YtH8u',
];

const MINT_KEYS = /"(?:mint|base_mint|quote_mint)":"(\w+)"/g;
const BLOCK_TIME = /"block_time":(\d+)/;
/** Firehose files (≈2 min each) whose start stamp falls in this range; lifecycle files are read whole. */
const FIREHOSE_FROM = '20260926T130000Z';
const FIREHOSE_TO = '20260926T160000Z';
/** 2026-09-26 15:10:00 UTC: the recording's end. */
const END = 1790435400;
export const DEMO_FILE = 'samples/demo-20260926.jsonl.gz';

async function* tier(files: readonly string[], mints: ReadonlySet<string>): AsyncGenerator<string> {
  for (const file of files) {
    for await (const line of readJsonlLines(file)) {
      for (const m of line.matchAll(MINT_KEYS)) {
        if (m[1] !== undefined && mints.has(m[1])) {
          yield line;
          break;
        }
      }
    }
  }
}

/** Same merge rule as capture.ts: smallest last-seen `block_time` first; lines without one keep their tier's key. */
async function* merged(tiers: AsyncGenerator<string>[]): AsyncGenerator<string> {
  const cursors = tiers.map((lines) => ({ lines, line: null as string | null, key: 0 }));
  const advance = async (c: (typeof cursors)[number]) => {
    const next = await c.lines.next();
    c.line = next.done === true ? null : next.value;
    const t = c.line === null ? null : BLOCK_TIME.exec(c.line);
    if (t?.[1] !== undefined) c.key = Number(t[1]);
  };
  for (const c of cursors) await advance(c);
  for (;;) {
    const live = cursors.filter((c) => c.line !== null);
    if (live.length === 0) return;
    const c = live.reduce((a, b) => (b.key < a.key ? b : a));
    if (c.key <= END) yield c.line!;
    await advance(c);
  }
}

async function main(): Promise<void> {
  const dir = 'data/live';
  const names = readdirSync(dir).sort();
  const lifecycle = names.filter((n) => n.startsWith('lifecycle-20260926')).map((n) => join(dir, n));
  const firehose = names
    .filter((n) => n.startsWith('firehose-') && n.slice(9, 25) >= FIREHOSE_FROM && n.slice(9, 25) < FIREHOSE_TO)
    .map((n) => join(dir, n));
  const mints = new Set(DEMO_MINTS);
  let lines = 0;
  async function* out(): AsyncGenerator<string> {
    for await (const line of merged([tier(lifecycle, mints), tier(firehose, mints)])) {
      const clean = redactSecrets(line, process.env.SOLAMI_API_KEY ?? null);
      if (/sk_/i.test(clean)) throw new Error(`a line still carries something like a key: ${clean.slice(0, 120)}…`);
      lines += 1;
      yield `${clean}\n`;
    }
  }
  mkdirSync('samples', { recursive: true });
  await pipeline(Readable.from(out()), createGzip({ level: 9 }), createWriteStream(DEMO_FILE));
  console.log(`${DEMO_FILE}: ${lines} frames of ${mints.size} tokens (${lifecycle.length} lifecycle + ${firehose.length} firehose files read)`);
}

if (process.argv[1]?.endsWith('demo.js')) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
