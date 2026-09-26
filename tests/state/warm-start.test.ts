import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStateStore, stateHealth, summarizeState, warmStart } from '../../src/state/factory.js';
import { warmStartFiles } from '../../src/state/warm-start.js';
import { snapshot, testConfig } from './helpers.js';
import { SESSION } from '../ingest/helpers.js';

const at = (iso: string) => Date.parse(iso);

describe('warmStartFiles', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rug-radar-warm-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('picks the lifecycle files that can hold the last N hours, oldest first', () => {
    for (const name of [
      'lifecycle-20260924T010000Z-0001.jsonl', // ends when the next starts: before the cutoff
      'lifecycle-20260924T200000Z-0002.jsonl', // started before the cutoff, runs past it
      'lifecycle-20260925T060000Z-0010.jsonl',
      'firehose-20260925T060000Z-0011.jsonl', // swaps/transfers: not replayed
      'notes.txt',
    ]) {
      writeFileSync(join(dir, name), '');
    }
    const files = warmStartFiles(dir, 12, at('2026-09-25T10:00:00Z')).map((f) => f.slice(dir.length + 1));
    expect(files).toEqual(['lifecycle-20260924T200000Z-0002.jsonl', 'lifecycle-20260925T060000Z-0010.jsonl']);
  });

  it('keeps the newest file even if it started before the cutoff; nothing if no dir', () => {
    writeFileSync(join(dir, 'lifecycle-20260920T000000Z-0001.jsonl'), '');
    expect(warmStartFiles(dir, 1, at('2026-09-25T10:00:00Z'))).toHaveLength(1);
    expect(warmStartFiles(join(dir, 'missing'), 1, 0)).toEqual([]);
  });

  it('replays into the store; overlapping with the live backfill changes nothing', async () => {
    const file = join(dir, 'lifecycle-20260925T000000Z-0001.jsonl');
    writeFileSync(file, `${SESSION.join('\n')}\n`);
    const config = testConfig();
    const warmed = createStateStore(config);
    const events = await warmStart(config, warmed, [file]);
    expect(events).toBeGreaterThan(0);
    expect(warmed.tokens.size).toBeGreaterThan(0);

    const before = snapshot(warmed);
    await warmStart(config, warmed, [file]); // the backfill resends the same events
    expect(snapshot(warmed)).toEqual(before);

    const health = stateHealth(warmed, null);
    expect(health.tokens.tracked).toBe(warmed.tokens.size);
    expect(health.memory.heapUsedMB).toBeGreaterThan(0);
    expect(summarizeState(health)).toContain('rest=off');
  });
});
