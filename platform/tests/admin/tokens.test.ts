// B03 AC1: token format (ADR-M26 D6). The DB side is in tests/integration/db/api.test.ts.
import {
  API_TOKEN_PATTERN,
  generateApiToken,
  isApiTokenFormat,
} from '../../packages/core/src/admin/tokens.js';
import { intentInputSha256, isCommandGate } from '../../packages/core/src/commands/gate-input.js';
import { hashApiToken } from '../../packages/core/src/db/repositories/api-tokens.js';
import type { Intent } from '../../packages/core/src/db/schema.js';
import { describe, expect, it } from 'vitest';

describe('API tokens', () => {
  it('are sdlc_pat_ + 32 random bytes, never repeated', () => {
    const tokens = new Set(Array.from({ length: 200 }, generateApiToken));
    expect(tokens.size).toBe(200);
    for (const token of tokens) {
      expect(token).toMatch(API_TOKEN_PATTERN);
      expect(isApiTokenFormat(token)).toBe(true);
      expect(hashApiToken(token)).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(isApiTokenFormat('sdlc_pat_short')).toBe(false);
    expect(isApiTokenFormat(` ${generateApiToken()}`)).toBe(false);
  });
});

describe('gate input binding (QUESTIONS.md #64)', () => {
  const intent = {
    code: 'INT-2026-0001',
    project_id: '0b8f4f3e-9d0e-4c3b-8a55-1f6a5c7d2e10',
    risk_tier: 'low',
    data_class: 'internal',
    budget_usd: '10.000000',
    title: 'Add labels',
    description: '',
  } as unknown as Intent;

  it('G1 hash is stable and changes with any bound field', () => {
    const base = intentInputSha256(intent);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(intentInputSha256({ ...intent })).toBe(base);
    for (const change of [
      { risk_tier: 'high' },
      { data_class: 'client_confidential' },
      { budget_usd: '11.000000' },
      { title: 'Add labels!' },
      { description: 'x' },
    ]) {
      expect(intentInputSha256({ ...intent, ...change } as Intent)).not.toBe(base);
    }
    // Status and current gate are not part of what G1 approves.
    expect(intentInputSha256({ ...intent, status: 'in_gate' })).toBe(base);
  });

  it('commands decide G1–G3 only', () => {
    expect(['G1', 'G2', 'G3', 'G4', 'G7', 'G8'].map(isCommandGate)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});
