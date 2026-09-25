import { describe, expect, it } from 'vitest';
import {
  elapsedMillis,
  elapsedSeconds,
  millisToSeconds,
  millisValue,
  secondsToMillis,
  secondsValue,
  unixMillis,
  unixSeconds,
  type UnixMillis,
  type UnixSeconds,
} from '../../src/core/time.js';

describe('branded time', () => {
  it('converts seconds to millis and back', () => {
    const blockTime = unixSeconds(1790289332);
    expect(millisValue(secondsToMillis(blockTime))).toBe(1790289332000);
    expect(secondsValue(millisToSeconds(unixMillis(1790289333701)))).toBe(1790289333);
  });

  it('computes elapsed time only within the same unit', () => {
    expect(elapsedSeconds(unixSeconds(100), unixSeconds(160))).toBe(60);
    expect(elapsedMillis(unixMillis(2000), unixMillis(1500))).toBe(-500);
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('rejects %s', (bad) => {
    expect(() => unixSeconds(bad)).toThrow(RangeError);
    expect(() => unixMillis(bad)).toThrow(RangeError);
  });
});

// Compile-time guarantees, verified by `tsc --noEmit` (npm run lint). Never executed:
// if any of these lines stopped being an error, @ts-expect-error itself would fail the build.
export function compileTimeChecks(s: UnixSeconds, ms: UnixMillis): void {
  // @ts-expect-error seconds and millis cannot be subtracted
  void (s - ms);
  // @ts-expect-error seconds and millis cannot be added
  void (s + ms); // eslint-disable-line @typescript-eslint/restrict-plus-operands -- the error IS the point
  // @ts-expect-error no raw arithmetic even within one unit: use elapsedSeconds()
  void (s - s);
  // @ts-expect-error seconds and millis cannot be compared
  void (s < ms);
  // @ts-expect-error nor checked for equality
  void (s === ms);
  // Allowed on purpose: ordering within ONE unit is safe (runtime values are plain numbers).
  void (s < s);
  // @ts-expect-error millis are not accepted where seconds are expected
  secondsToMillis(ms);
  // @ts-expect-error a bare number is not a timestamp
  const bare: UnixSeconds = 1790289332;
  void bare;
}
