import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '../../src/config.js';
import { createLiveSource, createPersister, createReplaySource, priorityOf } from '../../src/ingest/factory.js';
import { fakeServer, STREAM_SAMPLE_PATH } from './helpers.js';

const base = loadConfig({ SOLAMI_API_KEY: 'sk_test' });
const withStream = (stream: Partial<AppConfig['stream']>): AppConfig => ({ ...base, stream: { ...base.stream, ...stream } });

describe('factory (config → sources)', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('subscribes to the types listed in the config, not hard-coded ones', async () => {
    const server = fakeServer();
    const source = createLiveSource(withStream({ types: ['token_create', 'graduation'], backfill: 50 }), {
      createSocket: server.createSocket,
      persister: null,
    });
    source.events();
    const url = new URL(server.last.url);
    expect(url.searchParams.get('type')).toBe('token_create,graduation');
    expect(url.searchParams.get('backfill')).toBe('50');
    await source.close();
  });

  it('the shipped config subscribes to the 7 types the detector needs', () => {
    expect(base.stream.types).toEqual(['token_create', 'pool_create', 'graduation', 'liquidity', 'transfer', 'swap', 'meme']);
  });

  it('refuses the live source without an API key', () => {
    expect(() => createLiveSource({ ...base, apiKey: null })).toThrow('SOLAMI_API_KEY');
  });

  it('maps types to backpressure priorities (control events are always critical)', () => {
    const p = priorityOf(base);
    expect(['token_create', 'pool_create', 'graduation', 'connected', 'backfill_end'].map(p)).toEqual(Array(5).fill('critical'));
    expect(['liquidity', 'meme', 'metadata'].map(p)).toEqual(Array(3).fill('normal'));
    expect(['swap', 'transfer', 'anything_new'].map(p)).toEqual(Array(3).fill('bulk'));
  });

  it('routes swap/transfer to the firehose tier and the rest to lifecycle', async () => {
    dir = mkdtempSync(join(tmpdir(), 'rug-radar-factory-'));
    const persister = createPersister({ ...base, persistence: { ...base.persistence, dir } })!;
    persister.write('swap', '{"type":"swap"}');
    persister.write('token_create', '{"type":"token_create"}');
    await persister.close();
    expect(readdirSync(dir).map((f) => f.split('-')[0]).sort()).toEqual(['firehose', 'lifecycle']);
    expect(createPersister({ ...base, persistence: { ...base.persistence, enabled: false } })).toBeNull();
  });

  it('builds a replay source over the given paths', () => {
    expect(createReplaySource(base, [STREAM_SAMPLE_PATH]).files).toEqual([STREAM_SAMPLE_PATH]);
  });
});
