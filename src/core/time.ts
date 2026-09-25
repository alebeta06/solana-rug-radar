/**
 * Branded timestamps (trap #2: `block_time`/`created_time` are seconds, `indexed_at` is millis).
 *
 * The common `number & { __brand }` pattern is NOT enough: TypeScript still lets you write
 * `seconds - millis` because both are numbers. Here the branded types are opaque interfaces,
 * so every arithmetic operator (+ - * /) on them is a compile error, and so is comparing
 * seconds with millis (`<`, `===`). Ordering within one unit (`a < b`) stays allowed: it is safe.
 * At runtime they are plain numbers (zero cost); all maths goes through the helpers below,
 * whose names state the unit.
 */
declare const unit: unique symbol;

export interface UnixSeconds {
  readonly [unit]: 'seconds';
}

export interface UnixMillis {
  readonly [unit]: 'millis';
}

export type Clock = () => UnixMillis;

function assertTimestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer, got ${value}`);
  }
}

export function unixSeconds(value: number): UnixSeconds {
  assertTimestamp(value, 'UnixSeconds');
  return value as unknown as UnixSeconds;
}

export function unixMillis(value: number): UnixMillis {
  assertTimestamp(value, 'UnixMillis');
  return value as unknown as UnixMillis;
}

/** Raw number, for serialization or display. The unit is in the function name on purpose. */
export function secondsValue(t: UnixSeconds): number {
  return t as unknown as number;
}

export function millisValue(t: UnixMillis): number {
  return t as unknown as number;
}

export function secondsToMillis(t: UnixSeconds): UnixMillis {
  return unixMillis(secondsValue(t) * 1000);
}

/** Truncates: sub-second precision is dropped. */
export function millisToSeconds(t: UnixMillis): UnixSeconds {
  return unixSeconds(Math.floor(millisValue(t) / 1000));
}

/** `to - from` in seconds (negative if `to` is earlier). */
export function elapsedSeconds(from: UnixSeconds, to: UnixSeconds): number {
  return secondsValue(to) - secondsValue(from);
}

/** `to - from` in milliseconds (negative if `to` is earlier). */
export function elapsedMillis(from: UnixMillis, to: UnixMillis): number {
  return millisValue(to) - millisValue(from);
}

export const systemClock: Clock = () => unixMillis(Date.now());
