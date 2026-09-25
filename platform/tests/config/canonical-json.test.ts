// RFC 8785 (JSON Canonicalization Scheme), used for config_hash (and later the audit hash chain).
// Test values from RFC 8785 §3.2.2.3 (numbers) and §3.2.3 (sorting).
import { canonicalJson } from '@sdlc/config';
import { describe, expect, it } from 'vitest';

describe('canonicalJson (RFC 8785)', () => {
  it.each([
    [0, '0'],
    [-0, '0'],
    [1e21, '1e+21'],
    [1e-7, '1e-7'],
    [0.000001, '0.000001'],
    // RFC 8785 example: the literal is rounded to the nearest double, which is the point of the test.
    // eslint-disable-next-line no-loss-of-precision
    [333333333.33333329, '333333333.3333333'],
    [1e30, '1e+30'],
    [4.5, '4.5'],
    [2e-3, '0.002'],
    [1e-27, '1e-27'],
    [9007199254740991, '9007199254740991'],
    [-9007199254740991, '-9007199254740991'],
    [5e-324, '5e-324'],
  ])('serialises the number %s as %s', (value, expected) => {
    expect(canonicalJson(value)).toBe(expected);
  });

  it('sorts keys by UTF-16 code units (RFC 8785 §3.2.3)', () => {
    const input = {
      '\u20ac': 'Euro Sign',
      '\r': 'Carriage Return',
      '\ufb33': 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '\ud83d\ude00': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      '\u00f6': 'Latin Small Letter O With Diaeresis',
    };
    // Read the keys from the text: a parsed object would list the integer-like key "1" first.
    const keys = [...canonicalJson(input).matchAll(/"((?:[^"\\]|\\.)*)":/g)].map(
      (match) => JSON.parse(`"${match[1] ?? ''}"`) as string,
    );
    expect(keys).toEqual(['\r', '1', '\u0080', '\u00f6', '\u20ac', '\ud83d\ude00', '\ufb33']);
  });

  it('writes no whitespace and escapes strings like ECMAScript JSON', () => {
    expect(canonicalJson({ b: [1, true, null], a: 'x\ny\u000f\u2028"' })).toBe(
      '{"a":"x\\ny\\u000f\u2028\\"","b":[1,true,null]}',
    );
  });

  it('sorts nested objects and keeps array order', () => {
    expect(canonicalJson({ z: { b: 1, a: 2 }, a: [{ d: 1, c: 2 }] })).toBe(
      '{"a":[{"c":2,"d":1}],"z":{"a":2,"b":1}}',
    );
  });

  it('leaves out object members whose value is undefined', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a lone surrogate', '\ud800'],
    ['a function', () => 1],
    ['a date', new Date(0)],
    ['an undefined array item', [undefined]],
    ['a bigint', 1n],
  ])('refuses %s', (_name, value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });
});
