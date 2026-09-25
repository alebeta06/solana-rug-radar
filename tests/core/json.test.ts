import { describe, expect, it } from 'vitest';
import { parseJsonLossless } from '../../src/core/json.js';

describe('parseJsonLossless', () => {
  it('keeps integers above 2^53 exact, as bigint (real swap reserve)', () => {
    const text = '{"base_reserve":11196105564446459}';
    expect((JSON.parse(text) as { base_reserve: number }).base_reserve).toBe(11196105564446460); // the trap
    expect(parseJsonLossless(text)).toEqual({ base_reserve: 11196105564446459n });
  });

  it('keeps i64::MAX exact', () => {
    expect(parseJsonLossless('[9223372036854775807]')).toEqual([9223372036854775807n]);
  });

  it('leaves safe integers, decimals and strings untouched', () => {
    expect(parseJsonLossless('{"slot":450165443,"x":1.5,"liquidity_usd":"2.96","n":null}')).toEqual({
      slot: 450165443,
      x: 1.5,
      liquidity_usd: '2.96',
      n: null,
    });
  });

  it('does not turn huge non-integer literals into bigint', () => {
    expect(parseJsonLossless('1e300')).toBe(1e300);
  });

  it('throws on invalid JSON', () => {
    expect(() => parseJsonLossless('{')).toThrow(SyntaxError);
  });
});
