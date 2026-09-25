// A09 FAULT INJECTION (unit test): a failing assertion must fail `pnpm test`.
import { describe, expect, it } from 'vitest';

describe('A09 fault injection', () => {
  it('fails on purpose', () => {
    expect(1 + 1).toBe(3);
  });
});
