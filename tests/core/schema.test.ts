import { describe, expect, it } from 'vitest';
import {
  Decimal,
  decimalString,
  I64_MAX,
  millisField,
  millisOrSentinelAsNull,
  optionalText,
  rawAmount,
  redactApiKey,
  secondsField,
  secondsOrZeroAsNull,
} from '../../src/core/schema.js';
import { millisValue, secondsValue } from '../../src/core/time.js';

describe('decimalString', () => {
  it.each(['1297.98', '0.0000000012', '100', '-3', '1e-7', '0.0000001277937269484'])('accepts %s', (s) => {
    const d = decimalString.parse(s);
    expect(d).toBeInstanceOf(Decimal);
    expect(d.equals(new Decimal(s))).toBe(true);
  });

  it.each([1.5, '', 'NaN', 'Infinity', '1,5', ' 1', '0x10', null])('rejects %s', (bad) => {
    expect(decimalString.safeParse(bad).success).toBe(false);
  });

  it('fixes the string-arithmetic trap', () => {
    expect('1.5' + '0.5').toBe('1.50.5');
    expect(decimalString.parse('1.5').plus(decimalString.parse('0.5')).toString()).toBe('2');
  });

  it('fixes the string-sorting trap', () => {
    expect(['10', '9'].sort()).toEqual(['10', '9']);
    const sorted = ['10', '9'].map((s) => decimalString.parse(s)).sort((a, b) => a.comparedTo(b));
    expect(sorted.map(String)).toEqual(['9', '10']);
  });

  it('keeps every digit of long decimals', () => {
    expect(decimalString.parse('0.0000044073818509130765').toString()).toBe('0.0000044073818509130765');
  });
});

describe('rawAmount', () => {
  it('normalizes numbers and bigints to bigint', () => {
    expect(rawAmount.parse(42)).toBe(42n);
    expect(rawAmount.parse(16103776596248955n)).toBe(16103776596248955n);
  });

  it('rejects decimals and strings', () => {
    expect(rawAmount.safeParse(1.5).success).toBe(false);
    expect(rawAmount.safeParse('42').success).toBe(false);
  });
});

describe('timestamps at the border', () => {
  it('parses seconds and millis', () => {
    expect(secondsValue(secondsField.parse(1790289332))).toBe(1790289332);
    expect(millisValue(millisField.parse(1790289333701))).toBe(1790289333701);
  });

  it('rejects a millis value in a seconds field and vice versa', () => {
    expect(secondsField.safeParse(1790289333701).success).toBe(false);
    expect(millisField.safeParse(1790289332).success).toBe(false);
  });

  it('treats graduated_time 0 as "not graduated", not 1970', () => {
    expect(secondsOrZeroAsNull.parse(0)).toBeNull();
    expect(secondsValue(secondsOrZeroAsNull.parse(1790284920)!)).toBe(1790284920);
  });

  it('treats the i64::MAX sentinel as no timestamp', () => {
    expect(millisOrSentinelAsNull.parse(I64_MAX)).toBeNull();
    expect(millisValue(millisOrSentinelAsNull.parse(1790230122438)!)).toBe(1790230122438);
    expect(millisOrSentinelAsNull.safeParse(123n).success).toBe(false);
  });
});

describe('optionalText', () => {
  it('maps missing, null and empty to null', () => {
    expect(optionalText.parse(undefined)).toBeNull();
    expect(optionalText.parse(null)).toBeNull();
    expect(optionalText.parse('')).toBeNull();
    expect(optionalText.parse('x')).toBe('x');
  });
});

describe('redactApiKey', () => {
  it('removes api_key and keeps other params', () => {
    expect(redactApiKey('https://api.solami.dev/data/token/image/M?api_key=sk_secret&size=64')).toBe(
      'https://api.solami.dev/data/token/image/M?size=64',
    );
  });

  it('leaves URLs without a key untouched', () => {
    expect(redactApiKey('https://tether.to/logo.png')).toBe('https://tether.to/logo.png');
  });

  it('redacts even in strings that are not valid URLs', () => {
    expect(redactApiKey('not a url?api_key=sk_secret')).toBe('not a url?api_key=REDACTED');
  });
});
