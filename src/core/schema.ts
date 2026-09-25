/**
 * Field-level validators for the normalization border. Every raw Solami field goes through
 * one of these; nothing numeric leaves the border as a string (trap #1) and every timestamp
 * leaves it branded with its unit (trap #2).
 */
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { unixMillis, unixSeconds } from './time.js';

export { Decimal };

const DECIMAL_STRING = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

/**
 * A decimal sent as a JSON string ("2.963216863765038") → Decimal, without precision loss.
 * Rejects JSON numbers on purpose: if Solami ever changes a field's type we want a loud error,
 * not a silent change in behaviour.
 */
export const decimalString = z
  .string()
  .regex(DECIMAL_STRING, 'expected a decimal string')
  .transform((s) => new Decimal(s));

/** Counts and indexes (holders, slot, trades, decimals…): must be a safe integer. */
export const safeInt = z.int();

/**
 * Raw on-chain amounts (reserves, swap amounts). Arrive as JSON numbers but can exceed 2^53;
 * `parseJsonLossless` turns those into bigint. Normalized to bigint always, so callers get
 * one type regardless of magnitude.
 */
export const rawAmount = z.union([z.int(), z.bigint()]).transform((v) => BigInt(v));

/**
 * 10^11 separates the two units for any realistic date: as seconds it is year 5138, as millis
 * it is 1973. So a millis value in a seconds field (or vice versa) is rejected at the border.
 */
const UNIT_BOUNDARY = 100_000_000_000;

export const secondsField = z.int().min(0).max(UNIT_BOUNDARY - 1).transform(unixSeconds);

export const millisField = z.int().min(UNIT_BOUNDARY).transform(unixMillis);

/** `graduated_time`: 0 means "not graduated yet", not 1970-01-01. */
export const secondsOrZeroAsNull = z
  .int()
  .min(0)
  .max(UNIT_BOUNDARY - 1)
  .transform((v) => (v === 0 ? null : unixSeconds(v)));

/** i64::MAX, used by Solami's metadata resolver as "no timestamp". */
export const I64_MAX = 9223372036854775807n;

export const millisOrSentinelAsNull = z
  .union([millisField, z.literal(I64_MAX)])
  .transform((v) => (typeof v === 'bigint' ? null : v));

/** Optional text: missing, null and "" all become null. */
export const optionalText = z
  .string()
  .nullish()
  .transform((s) => (s === undefined || s === null || s === '' ? null : s));

/** Removes `api_key` from URLs Solami builds with our own key embedded (metadata `image_url`). */
export function redactApiKey(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has('api_key')) return url;
    parsed.searchParams.delete('api_key');
    return parsed.toString();
  } catch {
    return url.replace(/api_key=[^&#]*/g, 'api_key=REDACTED');
  }
}

export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`);
}
