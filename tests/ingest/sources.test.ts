import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
});
