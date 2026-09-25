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
  stream: z
    .object({
      url: z.url(),
      chain: z.string().min(1),
      /** Subscription; also sent as the `type=` list. */
      types: z.array(z.string().min(1)).min(1),
      /** Events per type replayed on (re)connect. */
      backfill: z.int().min(0).max(200),
      /** Keys remembered per type; must cover `backfill` or reconnect duplicates slip through. */
      dedupWindowPerType: positiveInt,
      /** No frame for this long = dead connection (the stream carries ~1000 frames/s). */
      staleAfterMs: positiveInt,
      reconnect: z.object({
        initialDelayMs: positiveInt,
        maxDelayMs: positiveInt,
        multiplier: z.number().min(1),
        /** A connection that lived this long resets the backoff. */
        resetAfterMs: positiveInt,
      }),
      queue: z.object({
        capacity: positiveInt,
        /** Types dropped last under backpressure; types in neither list are "bulk", dropped first. */
        critical: z.array(z.string()),
        normal: z.array(z.string()),
      }),
    })
    .refine((s) => s.dedupWindowPerType >= s.backfill, {
      message: 'dedupWindowPerType must be >= backfill',
      path: ['dedupWindowPerType'],
    })
    .refine((s) => s.reconnect.maxDelayMs >= s.reconnect.initialDelayMs, {
      message: 'maxDelayMs must be >= initialDelayMs',
      path: ['reconnect', 'maxDelayMs'],
    }),
  persistence: z.object({
    enabled: z.boolean(),
    dir: z.string().min(1),
    maxFileMB: positiveInt,
    /** Pending-write buffer; beyond it raw lines are dropped (counted) instead of eating RAM. */
    maxBufferMB: positiveInt,
    /** Raw types stored in the short-retention tier; everything else is "lifecycle". */
    firehoseTypes: z.array(z.string()),
    lifecycleMaxTotalMB: positiveInt,
    firehoseMaxTotalMB: positiveInt,
  }),
  health: z.object({
    port: z.int().min(0).max(65535),
    logEveryMs: positiveInt,
  }),
});

/** Disk caps can be raised per machine from the environment, without editing the shared config. */
const ENV_OVERRIDES = {
  PERSIST_LIFECYCLE_MAX_MB: 'lifecycleMaxTotalMB',
  PERSIST_FIREHOSE_MAX_MB: 'firehoseMaxTotalMB',
} as const;

function applyEnvOverrides(json: unknown, env: NodeJS.ProcessEnv): unknown {
  const persistence = (json as { persistence?: Record<string, unknown> } | null)?.persistence;
  if (persistence === undefined) return json;
  const patched = { ...persistence };
  for (const [name, field] of Object.entries(ENV_OVERRIDES)) {
    const value = env[name]?.trim();
    if (value === undefined || value === '') continue;
    if (!/^\d+$/.test(value)) throw new Error(`invalid config: ${name} must be a whole number of MB`);
    patched[field] = Number(value);
  }
  return { ...(json as object), persistence: patched };
}

export type FileConfig = z.output<typeof configSchema>;

export interface AppConfig extends FileConfig {
  /** null is allowed for offline tools (replay); the REST client requires it. */
  readonly apiKey: string | null;
}

export const DEFAULT_CONFIG_PATH = 'config/config.json';

export function parseConfig(json: unknown, env: NodeJS.ProcessEnv): AppConfig {
  const parsed = configSchema.safeParse(applyEnvOverrides(json, env));
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
