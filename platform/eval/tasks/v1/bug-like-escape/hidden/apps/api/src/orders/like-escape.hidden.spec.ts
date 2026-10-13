import { describe, expect, it } from '@jest/globals';
import { likePattern } from './order-rules.js';

describe('likePattern (hidden)', () => {
  it('escapes an underscore', () => {
    expect(likePattern('A_B')).toBe('%A\\_B%');
  });

  it('escapes a percent sign and a backslash', () => {
    expect(likePattern('50%')).toBe('%50\\%%');
    expect(likePattern('a\\b')).toBe('%a\\\\b%');
  });

  it('keeps plain text as it is', () => {
    expect(likePattern('Tanaka')).toBe('%Tanaka%');
  });
});
