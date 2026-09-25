/**
 * Configuration: tunables from a JSON file (default config/config.json, override with
 * CONFIG_PATH), secrets from the environment. Validated once at startup: a typo in a
 * threshold fails fast instead of silently disabling a detection rule.
 *
 * Decimal thresholds are JSON strings, parsed with the same border rules as Solami data.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { decimalString, formatIssues } from './core/schema.js';

const positiveInt = z.int().positive();

const configSchema = z.object({
  detection: z.object({
    /** Signal 1 (primary): launches by one creator inside the window. Anomalous if > maxNormalLaunches. */
    launchBurst: z.object({ windowHours: positiveInt, maxNormalLaunches: positiveInt }),
    /** Signal 2 (confirmation): liquidity collapsed while holders stay high, after a real peak. */
    liquidityCollapse: z.object({
      maxLiquidityUsd: decimalString,
      minHolders: positiveInt,
      minAthMcapUsd: decimalString,
    }),
    /** Signal 3 (automation): final liquidity repeated across the same creator's tokens. */
    automation: z.object({ maxLiquiditySpreadUsd: decimalString, minMatchingTokens: positiveInt }),
  }),
  rest: z.object({
    baseUrl: z.url(),
    requestsPerSecond: z.number().positive(),
    burst: positiveInt,
    maxQueue: z.int().nonnegative(),
    timeoutMs: positiveInt,
    devHistoryTokenLimit: positiveInt,
    cache: z.object({
      identityMaxEntries: positiveInt,
      securityTtlSeconds: positiveInt,
      securityMaxEntries: positiveInt,
      devHistoryTtlSeconds: positiveInt,
      devHistoryMaxEntries: positiveInt,
    }),
    liquidityHistory: z.object({ maxMints: positiveInt, maxReadingsPerMint: positiveInt }),
  }),
});

export type FileConfig = z.output<typeof configSchema>;

export interface AppConfig extends FileConfig {
  /** null is allowed for offline tools (replay); the REST client requires it. */
  readonly apiKey: string | null;
}

export const DEFAULT_CONFIG_PATH = 'config/config.json';

export function parseConfig(json: unknown, env: NodeJS.ProcessEnv): AppConfig {
  const parsed = configSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`invalid config:\n  ${formatIssues(parsed.error).join('\n  ')}`);
  }
  const apiKey = env.SOLAMI_API_KEY?.trim();
  return { ...parsed.data, apiKey: apiKey === undefined || apiKey === '' ? null : apiKey };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const path = env.CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
  return parseConfig(JSON.parse(readFileSync(path, 'utf8')) as unknown, env);
}
