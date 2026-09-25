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

  it('fails fast on an invalid threshold, naming the field', () => {
    const bad = {
      ...fileJson,
      detection: { ...fileJson.detection, liquidityCollapse: { ...fileJson.detection.liquidityCollapse, maxLiquidityUsd: '5,0' } },
    };
    expect(() => parseConfig(bad, {})).toThrow('detection.liquidityCollapse.maxLiquidityUsd');
  });
});
