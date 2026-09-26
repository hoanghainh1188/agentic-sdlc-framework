// D-08 C02 AC1: the Run Contract schema of D-03 section 8 (ADR-M22 section 2.1).
import {
  parseRunContractEnvelope,
  RUN_CONTRACT_FIELDS,
  signatureKeyVersion,
  validateRunContract,
} from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import { contract, SAMPLE_CONTRACT } from './helpers';

const fieldOf = (value: unknown) => {
  const result = validateRunContract(value);
  return result.ok ? 'ok' : result.field;
};

describe('Run Contract schema (AC1)', () => {
  it('has the fields of D-03 section 8, plus schema_version, plan and allowed_tools (QUESTIONS #34)', () => {
    expect([...RUN_CONTRACT_FIELDS]).toEqual([
      'schema_version',
      'run_id',
      'intent_id',
      'tenant_id',
      'project_id',
      'repo',
      'base_sha',
      'branch',
      'plan_id',
      'plan_sha256',
      'planned_files',
      'agent_id',
      'agent_version',
      'instructions_sha256',
      'allowed_tools',
      'autonomy_level',
      'max_budget_usd',
      'max_iterations',
      'max_duration_min',
      'loop_threshold',
      'allowed_models',
      'egress_allowlist',
      'issued_at',
      'expires_at',
    ]);
  });

  it('accepts the sample contract', () => {
    expect(fieldOf(SAMPLE_CONTRACT)).toBe('ok');
    expect(fieldOf(contract({ allowed_tools: [] }))).toBe('ok');
  });

  it('refuses a missing field and an extra field', () => {
    const missing: Record<string, unknown> = { ...SAMPLE_CONTRACT };
    delete missing.repo;
    expect(fieldOf(missing)).toBe('repo');
    expect(fieldOf({ ...SAMPLE_CONTRACT, note: 'please be careful' })).toBe('note');
    expect(fieldOf(null)).toBe('(contract)');
    expect(fieldOf([SAMPLE_CONTRACT])).toBe('(contract)');
  });

  it.each([
    ['schema_version', 2],
    ['run_id', 'RUN-1'],
    ['run_id', '11111111-1111-4111-8111-11111111111A'],
    ['repo', 'org'],
    ['base_sha', 'a'.repeat(39)],
    ['branch', 'main'],
    ['branch', 'agent/INT-2026-1/../main'],
    ['plan_sha256', 'B'.repeat(64)],
    ['planned_files', []],
    ['planned_files', ['a\0b']],
    ['agent_version', 'v 1'],
    ['allowed_tools', ['git', 'editor']],
    ['allowed_tools', ['git', 'git']],
    ['allowed_tools', ['rm -rf']],
    ['autonomy_level', 'L0'],
    ['autonomy_level', 'L3'],
    ['max_budget_usd', 2],
    ['max_budget_usd', '0'],
    ['max_budget_usd', '1.1234567'],
    ['max_budget_usd', '-1'],
    ['max_iterations', 0],
    ['max_iterations', 1.5],
    ['max_duration_min', '60'],
    ['loop_threshold', -3],
    ['allowed_models', []],
    ['egress_allowlist', ['github.com', 'api.github.com']],
    ['egress_allowlist', ['https://github.com']],
    ['issued_at', '2026-09-26T08:00:00Z'],
    ['issued_at', '2026-02-30T08:00:00.000Z'],
    ['expires_at', '2026-09-26T08:00:00.000Z'],
    ['expires_at', '2026-09-26T07:00:00.000Z'],
  ])('refuses %s = %j', (field, value) => {
    expect(fieldOf(contract({ [field]: value }))).toBe(field);
  });
});

describe('signature and envelope', () => {
  it('reads the key version from a Transit signature', () => {
    expect(signatureKeyVersion('vault:v1:QUJD')).toBe(1);
    expect(signatureKeyVersion('vault:v12:QUJD==')).toBe(12);
    for (const bad of [
      'vault:v0:QUJD',
      'v1:QUJD',
      'vault:v1:',
      'vault:v1:QU JD',
      42,
      'x'.repeat(600),
    ]) {
      expect(signatureKeyVersion(bad), String(bad)).toBeUndefined();
    }
  });

  it('parses an envelope with exactly a valid contract and a signature', () => {
    expect(
      parseRunContractEnvelope({ contract: SAMPLE_CONTRACT, signature: 'vault:v3:QUJD' }),
    ).toEqual({
      contract: SAMPLE_CONTRACT,
      signature: 'vault:v3:QUJD',
      keyVersion: 3,
    });
    for (const bad of [
      null,
      { contract: SAMPLE_CONTRACT },
      { contract: SAMPLE_CONTRACT, signature: 'vault:v1:QUJD', extra: 1 },
      { contract: { ...SAMPLE_CONTRACT, run_id: 'x' }, signature: 'vault:v1:QUJD' },
      { contract: SAMPLE_CONTRACT, signature: 'nope' },
    ]) {
      expect(parseRunContractEnvelope(bad)).toBeUndefined();
    }
  });
});
