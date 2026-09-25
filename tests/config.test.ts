import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/core/schema.js';
import { loadConfig, parseConfig } from '../src/config.js';

const fileJson = JSON.parse(readFileSync('config/config.json', 'utf8')) as {
  detection: { liquidityCollapse: Record<string, unknown> };
};

describe('config', () => {
  it('loads the shipped config with the validated thresholds', () => {
    const config = loadConfig({});
    expect(config.detection.launchBurst).toEqual({ windowHours: 24, maxNormalLaunches: 10 });
    expect(config.detection.liquidityCollapse.maxLiquidityUsd).toEqual(new Decimal('5'));
    expect(config.rest.requestsPerSecond).toBe(1);
    expect(config.apiKey).toBeNull();
  });

  it('reads the API key from the environment only', () => {
    expect(parseConfig(fileJson, { SOLAMI_API_KEY: ' sk_x ' }).apiKey).toBe('sk_x');
    expect(parseConfig(fileJson, { SOLAMI_API_KEY: '' }).apiKey).toBeNull();
  });

  it('ships conservative disk caps (a jury runs it without reading the config)', () => {
    const { persistence } = loadConfig({});
    expect(persistence).toMatchObject({ lifecycleMaxTotalMB: 1024, firehoseMaxTotalMB: 500 });
  });

  it('lets the environment raise the disk caps', () => {
    const config = parseConfig(fileJson, { PERSIST_LIFECYCLE_MAX_MB: '10240', PERSIST_FIREHOSE_MAX_MB: '5120' });
    expect(config.persistence).toMatchObject({ lifecycleMaxTotalMB: 10240, firehoseMaxTotalMB: 5120 });
    expect(() => parseConfig(fileJson, { PERSIST_FIREHOSE_MAX_MB: '5GB' })).toThrow('PERSIST_FIREHOSE_MAX_MB');
  });

  it('rejects a dedup window smaller than the backfill (reconnect duplicates would slip through)', () => {
    const json = fileJson as unknown as { stream: Record<string, unknown> };
    const bad = { ...json, stream: { ...json.stream, dedupWindowPerType: 100, backfill: 200 } };
    expect(() => parseConfig(bad, {})).toThrow('stream.dedupWindowPerType');
  });

  it('fails fast on an invalid threshold, naming the field', () => {
    const bad = {
      ...fileJson,
      detection: { ...fileJson.detection, liquidityCollapse: { ...fileJson.detection.liquidityCollapse, maxLiquidityUsd: '5,0' } },
    };
    expect(() => parseConfig(bad, {})).toThrow('detection.liquidityCollapse.maxLiquidityUsd');
  });
});
