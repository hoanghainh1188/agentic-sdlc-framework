import { describe, expect, it } from '@jest/globals';
import { isValidSku } from './sku-rules.js';

describe('isValidSku (hidden)', () => {
  it('accepts the format AAA-999', () => {
    expect(isValidSku('TEA-001')).toBe(true);
    expect(isValidSku('RCE-012')).toBe(true);
  });

  it('trims spaces at both ends first', () => {
    expect(isValidSku('  TEA-001 ')).toBe(true);
  });

  it.each(['TEA-1', 'tea-001', 'TEAS-001', 'TEA_001', '', 'TE-0001', 'TEA-0012'])(
    'refuses %j',
    (sku) => {
      expect(isValidSku(sku)).toBe(false);
    },
  );
});
