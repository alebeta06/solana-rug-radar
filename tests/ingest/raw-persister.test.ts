import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unixMillis } from '../../src/core/time.js';
import { RawPersister, type RawPersisterOptions } from '../../src/ingest/raw-persister.js';

const DAY1 = Date.UTC(2026, 8, 24, 23, 59, 0);

describe('RawPersister', () => {
  let dir: string;
  let now: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rug-radar-'));
    now = DAY1;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const make = (overrides: Partial<RawPersisterOptions> = {}) =>
    new RawPersister({
      dir,
      maxFileBytes: 1000,
      maxBufferBytes: 1_000_000,
      tiers: { lifecycle: { maxTotalBytes: 100_000 }, firehose: { maxTotalBytes: 100_000 } },
      tierOf: (type) => (type === 'swap' || type === 'transfer' ? 'firehose' : 'lifecycle'),
      apiKey: 'sk_live_secret',
      clock: () => unixMillis(now),
      ...overrides,
    });
  const files = () => readdirSync(dir).sort();
  const read = (name: string) => readFileSync(join(dir, name), 'utf8');

  it('writes JSONL per tier with the API key redacted', async () => {
    const p = make();
    p.write('metadata', '{"type":"metadata","image_url":"https://api.solami.dev/i/M?api_key=sk_live_secret"}');
    p.write('swap', '{"type":"swap","note":"sk_live_secret"}');
    p.write(null, 'garbage');
    await p.close();

    const [firehose, lifecycle] = files();
    expect(firehose).toMatch(/^firehose-20260924T235900Z-\d{4}\.jsonl$/);
    expect(read(lifecycle!)).toBe(
      '{"type":"metadata","image_url":"https://api.solami.dev/i/M?api_key=REDACTED"}\ngarbage\n',
    );
    expect(read(firehose!)).toBe('{"type":"swap","note":"REDACTED"}\n');
    expect(p.health()).toMatchObject({ linesWritten: 3, droppedLines: 0, lastError: null });
  });

  it('rotates by size', async () => {
    const p = make({ maxFileBytes: 250 });
    for (let i = 0; i < 10; i += 1) p.write('meme', `{"type":"meme","i":${i},"pad":"${'x'.repeat(60)}"}`);
    await p.close();
    expect(files().length).toBeGreaterThanOrEqual(4);
    for (const f of files()) expect(Buffer.byteLength(read(f))).toBeLessThanOrEqual(250);
    expect(files().map(read).join('').split('\n').filter(Boolean)).toHaveLength(10);
  });

  it('rotates when the UTC day changes', async () => {
    const p = make();
    p.write('meme', '{"type":"meme","d":1}');
    now = DAY1 + 2 * 60_000; // 00:01 next day
    p.write('meme', '{"type":"meme","d":2}');
    await p.close();
    expect(files()).toHaveLength(2);
    expect(files()[1]).toContain('20260925T000100Z');
  });

  it('keeps each tier under its cap by deleting its oldest files, never the other tier', async () => {
    writeFileSync(join(dir, 'lifecycle-20260101T000000Z-0000.jsonl'), 'x'.repeat(400)); // from a previous run
    const p = make({ maxFileBytes: 200, tiers: { lifecycle: { maxTotalBytes: 800 }, firehose: { maxTotalBytes: 100_000 } } });
    p.write('swap', '{"type":"swap"}');
    for (let i = 0; i < 30; i += 1) p.write('meme', `{"type":"meme","i":${i},"pad":"${'y'.repeat(40)}"}`);
    await p.close();

    const lifecycleBytes = files()
      .filter((f) => f.startsWith('lifecycle-'))
      .reduce((sum, f) => sum + Buffer.byteLength(read(f)), 0);
    expect(lifecycleBytes).toBeLessThanOrEqual(800);
    expect(files()).not.toContain('lifecycle-20260101T000000Z-0000.jsonl');
    expect(files().filter((f) => f.startsWith('firehose-'))).toHaveLength(1);
    expect(p.health().deletedFiles).toBeGreaterThan(0);
  });

  it('drops (and counts) lines when the disk cannot keep up, instead of buffering without limit', async () => {
    const p = make({ maxBufferBytes: 10 });
    for (let i = 0; i < 100; i += 1) p.write('swap', `{"type":"swap","i":${i}}`);
    expect(p.health().droppedLines).toBeGreaterThan(0);
    await p.close();
  });

  it('a disk error disables persistence and is reported, without throwing', async () => {
    const blocker = join(dir, 'not-a-dir');
    writeFileSync(blocker, '');
    const p = make({ dir: join(blocker, 'live') });
    expect(() => p.write('meme', '{"type":"meme"}')).not.toThrow();
    await p.close();
    expect(p.health().lastError).toMatch(/ENOTDIR|EEXIST/);
  });
});
