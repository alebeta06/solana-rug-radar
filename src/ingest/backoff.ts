/**
 * Reconnect delay: exponential backoff with "equal jitter".
 *
 * - Exponential: 1 s, 2 s, 4 s… up to `maxDelayMs`, so a server that is down is not hammered.
 * - Jitter: if Solami restarts, every client disconnected at the same instant; without jitter
 *   they would all come back at the same instant too (thundering herd).
 * - "Equal" jitter (half fixed, half random) instead of "full" jitter (0..base): full jitter can
 *   return ~0 ms, which is a tight reconnect loop in disguise.
 */
export interface BackoffOptions {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly multiplier: number;
}

/** @param attempt 1 for the first retry. @param random in [0, 1), injectable for tests. */
export function backoffDelay(
  attempt: number,
  options: BackoffOptions,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempt - 1);
  const base = Math.min(options.maxDelayMs, options.initialDelayMs * options.multiplier ** exponent);
  return Math.round(base / 2 + random() * (base / 2));
}
