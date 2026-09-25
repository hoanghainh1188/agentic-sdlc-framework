// D-02 FR-17, design/D-03 section 6.3: approvals are bound to a version, a scope and an expiry.
import { describe, expect, it } from 'vitest';

import { DbError } from '../../packages/core/src/db/errors.js';
import {
  checkApprovalBinding,
  normalizeScope,
  scopesEqual,
} from '../../packages/core/src/registry/approval-binding.js';

const HASH = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);
const NOW = new Date('2026-09-25T00:00:00.000Z');
const LATER = new Date('2026-10-02T00:00:00.000Z');

describe('normalizeScope', () => {
  it('sorts lists, removes duplicates and empty lists', () => {
    expect(
      normalizeScope({ environment: 'staging', resources: ['db:b', 'db:a', 'db:b'], actions: [] }),
    ).toEqual({ environment: 'staging', resources: ['db:a', 'db:b'] });
    expect(normalizeScope({})).toBeNull();
    expect(normalizeScope(undefined)).toBeNull();
    expect(normalizeScope(null)).toBeNull();
  });

  it('accepts codes only: no free text, no unknown keys', () => {
    for (const bad of [
      { environment: 'staging area' },
      { resources: ['orders of Tanaka-san'] },
      { resources: 'db:orders' },
      { note: 'x' },
      [],
      'staging',
      { resources: Array.from({ length: 51 }, (_, i) => `r${String(i)}`) },
    ]) {
      expect(() => normalizeScope(bad), JSON.stringify(bad)).toThrow(DbError);
    }
  });

  it('compares scopes as sets', () => {
    expect(scopesEqual({ resources: ['a', 'b'] }, { resources: ['b', 'a', 'a'] })).toBe(true);
    expect(scopesEqual({ resources: [] }, null)).toBe(true);
    expect(scopesEqual({ environment: 'staging' }, { environment: 'production' })).toBe(false);
  });
});

describe('checkApprovalBinding', () => {
  const approval = { input_sha256: HASH, scope: { environment: 'staging' }, expires_at: LATER };

  it('is valid for the same input and scope before the expiry', () => {
    expect(
      checkApprovalBinding(approval, {
        inputSha256: HASH,
        scope: { environment: 'staging' },
        now: NOW,
      }),
    ).toBe('valid');
  });

  it('reports a changed input, a changed scope or the expiry', () => {
    const current = { inputSha256: HASH, scope: { environment: 'staging' }, now: NOW };
    expect(checkApprovalBinding(approval, { ...current, inputSha256: OTHER })).toBe(
      'input_mismatch',
    );
    expect(checkApprovalBinding(approval, { ...current, scope: null })).toBe('scope_mismatch');
    expect(checkApprovalBinding(approval, { ...current, now: LATER })).toBe('expired');
    expect(checkApprovalBinding({ ...approval, expires_at: null }, current)).toBe('expired');
  });

  it('reports the expiry first when several reasons apply', () => {
    expect(checkApprovalBinding(approval, { inputSha256: OTHER, scope: null, now: LATER })).toBe(
      'expired',
    );
    expect(checkApprovalBinding(approval, { inputSha256: OTHER, scope: null, now: NOW })).toBe(
      'input_mismatch',
    );
  });
});
