import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unixMillis } from '../../src/core/time.js';
import type { SolamiEvent } from '../../src/events/types.js';
import { isHealthy, startHealthServer, summarizeHealth } from '../../src/ingest/health.js';
import { LiveSource } from '../../src/ingest/live-source.js';
import { expandJsonlPaths, ReplaySource } from '../../src/ingest/replay-source.js';
import type { SourceHealth } from '../../src/ingest/source.js';
import { collect, fakeServer, SESSION, settle, STREAM_SAMPLE_PATH } from './helpers.js';

/** An event minus the local receive time, which necessarily differs between runs. */
const comparable = (e: SolamiEvent) =>
  JSON.stringify(e, (k, v: unknown) => (k === 'receivedAt' ? undefined : typeof v === 'bigint' ? `${v}n` : v));

describe('one interface, two origins', () => {
  it('replay and live deliver exactly the same events for the same frames', async () => {
    const replay = new ReplaySource({ paths: [STREAM_SAMPLE_PATH], dedupWindowPerType: 1000 });
    const fromReplay = collect(replay.events());
    await fromReplay.done;

    const server = fakeServer();
    const live = new LiveSource({
      url: 'wss://x/data/subscribe', chain: 'solana', types: ['swap'], backfill: 200, apiKey: 'k',
      dedupWindowPerType: 1000, staleAfterMs: 60_000,
      reconnect: { initialDelayMs: 1000, maxDelayMs: 1000, multiplier: 1, resetAfterMs: 1000 },
      queueCapacity: 10_000, priorityOf: () => 'bulk', persister: null, createSocket: server.createSocket,
    });
    const fromLive = collect(live.events());
    server.last.open();
    server.last.send(...SESSION);
    await settle();
    await live.close();

    expect(fromReplay.items.length).toBe(SESSION.length);
    expect(fromLive.items.map(comparable)).toEqual(fromReplay.items.map(comparable));
    expect(replay.health()).toMatchObject({ origin: 'replay', state: 'closed', queue: null, connection: null });
  });
});

describe('ReplaySource', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'rug-radar-replay-'));
    mkdirSync(join(dir, 'live'));
    writeFileSync(join(dir, 'a.jsonl'), `${SESSION.slice(0, 50).join('\n')}\n`);
    writeFileSync(join(dir, 'live', 'b.jsonl'), `${SESSION.slice(30, 80).join('\n')}\n{ broken\n`);
    writeFileSync(join(dir, 'notes.txt'), 'ignored');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('expands directories recursively into sorted .jsonl files', () => {
    expect(expandJsonlPaths([dir, join(dir, 'missing')]).map((p) => p.slice(dir.length))).toEqual([
      '/a.jsonl',
      '/live/b.jsonl',
    ]);
  });

  it('deduplicates across files and survives malformed lines', async () => {
    const replay = new ReplaySource({ paths: [dir], dedupWindowPerType: 1000, warn: () => {} });
    const { items, done } = collect(replay.events());
    await done;
    expect(items).toHaveLength(80); // lines 30–49 appear in both files
    expect(replay.health().malformed.invalidJson).toBe(1);
  });

  it('does not split a line on U+2028/U+2029 inside a JSON string (node:readline does)', async () => {
    const tokenCreate = SESSION.find((line) => line.includes('"type":"token_create"')) ?? '';
    const withSeparators = tokenCreate.replace(/"name":"[^"]*"/, '"name":"MXM two lines"');
    const file = join(dir, 'separators.jsonl');
    writeFileSync(file, `${withSeparators}\r\n${SESSION[0]}`); // CRLF and no trailing newline too
    const replay = new ReplaySource({ paths: [file], dedupWindowPerType: 1000, warn: () => {} });
    const { items, done } = collect(replay.events());
    await done;
    rmSync(file);
    expect(replay.health().malformed.invalidJson).toBe(0);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ type: 'token_create', name: 'MXM two lines' });
  });

  it('reads .jsonl.gz transparently: the same file plain and compressed gives exactly the same frames', async () => {
    const plain = join(dir, 'gz-check', 'sample.jsonl');
    mkdirSync(join(dir, 'gz-check'));
    // Real frames plus a name with U+2028 and multi-byte characters, which must survive gunzip chunking.
    const tokenCreate = SESSION.find((line) => line.includes('"type":"token_create"')) ?? '';
    const text = `${readFileSync(STREAM_SAMPLE_PATH, 'utf8')}${tokenCreate.replace(/"name":"[^"]*"/, '"name":"ñandú 🚀\u2028two"').replace(/"signature":"[^"]*"/, '"signature":"gz-unique"')}\n`;
    writeFileSync(plain, text);
    writeFileSync(`${plain}.gz`, gzipSync(text));
    expect(expandJsonlPaths([join(dir, 'gz-check')]).map((p) => p.slice(dir.length))).toEqual(['/gz-check/sample.jsonl', '/gz-check/sample.jsonl.gz']);
    const read = async (path: string) => {
      const replay = new ReplaySource({ paths: [path], dedupWindowPerType: 1000, warn: () => {} });
      const { items, done } = collect(replay.events());
      await done;
      return { events: items.map(comparable), health: replay.health() };
    };
    const [a, b] = [await read(plain), await read(`${plain}.gz`)];
    rmSync(join(dir, 'gz-check'), { recursive: true });
    expect(a.events.length).toBeGreaterThan(200);
    expect(b.events).toEqual(a.events);
    expect(b.health.frames).toBe(a.health.frames);
    expect(b.health.malformed).toEqual(a.health.malformed);
    expect(b.events.at(-1)).toContain('ñandú 🚀\u2028two');
  });

  it('paces delivery on event time at `speed`, and not at all at speed 0', async () => {
    const tokenCreate = SESSION.find((line) => line.includes('"type":"token_create"')) ?? '';
    const at = (t: number, sig: string) => tokenCreate.replace(/"block_time":\d+/, `"block_time":${t}`).replace(/"signature":"[^"]*"/, `"signature":"${sig}"`);
    const file = join(dir, 'paced.jsonl');
    writeFileSync(file, [at(1_790_000_000, 'a'), at(1_790_000_010, 'b'), at(1_790_000_005, 'late'), at(1_790_000_030, 'c')].join('\n'));
    const run = async (speed: number) => {
      let wall = 5_000;
      const sleeps: number[] = [];
      const replay = new ReplaySource({
        paths: [file], dedupWindowPerType: 1000, speed, clock: () => unixMillis(wall),
        sleep: (ms) => { sleeps.push(ms); wall += ms; return Promise.resolve(); },
      });
      const { items, done } = collect(replay.events());
      await done;
      return { sleeps, received: items.map((e) => Number(e.receivedAt)) };
    };
    // 10×: +10 s of event time → 1 s; the late frame is not delayed; +30 s → 3 s after the first.
    expect(await run(10)).toEqual({ sleeps: [1000, 2000], received: [5000, 6000, 6000, 8000] });
    expect(await run(0)).toEqual({ sleeps: [], received: [5000, 5000, 5000, 5000] });
    rmSync(file);
  });

  it('close() stops the replay early', async () => {
    const replay = new ReplaySource({ paths: [STREAM_SAMPLE_PATH], dedupWindowPerType: 1000 });
    const iterator = replay.events();
    await iterator.next();
    await replay.close();
    expect((await iterator.next()).done).toBe(true);
  });
});

describe('health', () => {
  const base: SourceHealth = {
    origin: 'live', state: 'live', lastFrameAt: unixMillis(1_000_000), frames: 10,
    byType: { swap: { received: 5, duplicates: 1, dropped: 2, delivered: 2 } },
    malformed: { invalidJson: 1, notAnObject: 0, unknownType: 0, invalidShape: 0, recent: [] },
    queue: { length: 3, capacity: 10 },
    connection: { connectedSince: null, reconnects: 2, consecutiveFailures: 0, nextRetryAt: null, lastError: 'boom' },
    persistence: { bytesWritten: 2_500_000, linesWritten: 9, droppedLines: 4, deletedFiles: 0, currentFiles: {}, lastError: null },
  };

  it('is healthy only when live/backfilling and frames are recent', () => {
    expect(isHealthy(base, unixMillis(1_005_000), 30_000)).toBe(true);
    expect(isHealthy(base, unixMillis(1_031_000), 30_000)).toBe(false);
    expect(isHealthy({ ...base, state: 'reconnecting' }, unixMillis(1_000_001), 30_000)).toBe(false);
    expect(isHealthy({ ...base, origin: 'replay', state: 'closed' }, unixMillis(9e12), 1)).toBe(true);
  });

  it('summarizes the key numbers in one line', () => {
    const line = summarizeHealth(base, unixMillis(1_000_250));
    for (const part of ['live/live', 'last frame 250ms ago', 'MALFORMED=1', 'queue=3/10', 'reconnects=2', 'lastError="boom"', 'disk=2.5MB', 'diskDropped=4', 'swap=2 dup1 DROP2']) {
      expect(line).toContain(part);
    }
  });

  it('serves GET /health with 200/503', async () => {
    let health = base;
    const server = await startHealthServer(0, () => health, () => unixMillis(1_000_100), 30_000);
    const port = (server.address() as AddressInfo).port;
    const get = (path: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        request({ port, path }, (res) => {
          let body = '';
          res.on('data', (c: Buffer) => (body += c.toString()));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        }).on('error', reject).end();
      });
    const ok = await get('/health');
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ healthy: true, state: 'live', frames: 10 });
    health = { ...base, state: 'reconnecting' };
    expect((await get('/health')).status).toBe(503);
    expect((await get('/other')).status).toBe(404);
    await new Promise((resolve) => server.close(resolve));
  });

  it('serves what the memory knows under `state` when given', async () => {
    const server = await startHealthServer(0, () => base, () => unixMillis(1_000_100), 30_000, () => ({ tokens: { tracked: 7 } }));
    const port = (server.address() as AddressInfo).port;
    const body = await new Promise<string>((resolve, reject) => {
      request({ port, path: '/health' }, (res) => {
        let text = '';
        res.on('data', (c: Buffer) => (text += c.toString()));
        res.on('end', () => resolve(text));
      }).on('error', reject).end();
    });
    expect(JSON.parse(body)).toMatchObject({ healthy: true, frames: 10, state: { tokens: { tracked: 7 } } });
    await new Promise((resolve) => server.close(resolve));
  });
});
