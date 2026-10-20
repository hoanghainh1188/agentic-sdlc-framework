// The evaluation contract (task L04, design/ADR-M81 §2.2, QUESTIONS #460): its own schema, signed
// in the same form as the Run Contract, and never mistaken for it. The database side (issue,
// verify, the key, the sync) is in tests/integration/db/evaluation-contracts.test.ts.
import {
  EVALUATION_CONTRACT_FIELDS,
  EVALUATION_CONTRACT_KIND,
  parseEvaluationContractEnvelope,
  parseRunContractEnvelope,
  validateEvaluationContract,
  validateRunContract,
  type EvaluationRunContract,
} from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import {
  evaluationContractBytes,
  evaluationContractSha256,
} from '../../packages/core/src/evaluation/contract.js';
import { runContractBytes } from '../../packages/core/src/run-contract/canonical.js';

const ID = '11111111-1111-4111-8111-111111111111';
const contract = (over: Record<string, unknown> = {}): EvaluationRunContract => ({
  schema_version: 2,
  kind: 'evaluation',
  evaluation_run_id: '22222222-2222-4222-8222-222222222222',
  evaluation_id: '33333333-3333-4333-8333-333333333333',
  evaluation_code: 'EVAL-2026-0001',
  tenant_id: ID,
  project_id: '44444444-4444-4444-8444-444444444444',
  repo: 'acme/pilot-order-inventory',
  base_sha: '7d5341d'.padEnd(40, '0'),
  configuration_id: 'gpt-oss-20b',
  task_id: 'feat-tax',
  task_set_kind: 'folder',
  task_set_version: 1,
  task_set_commit: null,
  run_index: 1,
  attempt: 1,
  agent_version: '1.0.0',
  model: 'gpt-oss-20b',
  max_budget_usd: '0.4',
  max_iterations: 30,
  max_duration_min: 20,
  loop_threshold: 5,
  allowed_models: ['gpt-oss-20b'],
  egress_allowlist: ['litellm:4000', 'npm-proxy:4873'],
  issued_at: '2026-10-14T08:00:00.000Z',
  expires_at: '2026-10-14T08:30:00.000Z',
  ...over,
});

describe('the evaluation contract schema', () => {
  it('accepts a complete contract', () => {
    expect(validateEvaluationContract(contract())).toEqual({ ok: true, contract: contract() });
  });

  it.each([
    ['an intent (a real run has one)', { intent_id: ID }],
    ['a plan', { plan_id: ID }],
    ['a branch to push', { branch: 'agent/INT-2026-0001' }],
    ['another kind', { kind: 'run' }],
    ['a missing kind', { kind: undefined }],
    ['a code that is not EVAL-YYYY-NNNN', { evaluation_code: 'INT-2026-0001' }],
    ['a base commit that is a branch', { base_sha: 'main' }],
    ['attempt 0', { attempt: 0 }],
    ['a budget of 0', { max_budget_usd: '0' }],
    ['a budget as a float', { max_budget_usd: '1e-1' }],
    ['unsorted hosts', { egress_allowlist: ['npm-proxy:4873', 'litellm:4000'] }],
    ['a second model', { allowed_models: ['gpt-oss-20b', 'qwen3-8b'] }],
    ['a model other than the configuration', { allowed_models: ['qwen3-8b'] }],
    ['an expiry before the issue', { expires_at: '2026-10-14T07:00:00.000Z' }],
    ['schema 1 (before L07)', { schema_version: 1 }],
    ['another task set kind', { task_set_kind: 'sample' }],
    ['a folder set without a version', { task_set_version: null }],
    ['a folder set with a commit', { task_set_commit: '7d5341d'.padEnd(40, '1') }],
    ['a project set with a version', { task_set_kind: 'project', task_set_commit: 'a'.repeat(40) }],
    ['a project set without a commit', { task_set_kind: 'project', task_set_version: null }],
    [
      'a project set with a short commit',
      { task_set_kind: 'project', task_set_version: null, task_set_commit: 'abc' },
    ],
  ])('refuses %s', (_name, over) => {
    const value: Record<string, unknown> = { ...contract() };
    for (const [key, v] of Object.entries(over)) {
      if (v === undefined) delete value[key];
      else value[key] = v;
    }
    expect(validateEvaluationContract(value).ok).toBe(false);
  });

  it("accepts a project's task set: a commit and no version (L07)", () => {
    const value = contract({
      task_set_kind: 'project',
      task_set_version: null,
      task_set_commit: 'a'.repeat(40),
    });
    expect(validateEvaluationContract(value)).toEqual({ ok: true, contract: value });
  });

  it('names the first field that fails', () => {
    expect(validateEvaluationContract({ ...contract(), task_id: 'Feat Tax' })).toEqual({
      ok: false,
      field: 'task_id',
    });
    expect(validateEvaluationContract(null)).toEqual({ ok: false, field: '(contract)' });
  });

  it('has a fixed list of fields', () => {
    expect(EVALUATION_CONTRACT_FIELDS).toHaveLength(26);
    expect(EVALUATION_CONTRACT_KIND).toBe('evaluation');
  });
});

describe('the two kinds are never mistaken for each other', () => {
  it('a Run Contract is not an evaluation contract, and the other way round', () => {
    const evaluation = contract();
    expect(validateRunContract(evaluation).ok).toBe(false);
    const run = {
      schema_version: 1,
      run_id: ID,
      intent_id: ID,
      tenant_id: ID,
      project_id: ID,
      repo: 'acme/shop',
      base_sha: 'a'.repeat(40),
      branch: 'agent/INT-2026-0001',
      plan_id: ID,
      plan_sha256: 'b'.repeat(64),
      planned_files: ['src/**'],
      agent_id: ID,
      agent_version: '1.0.0',
      instructions_sha256: 'c'.repeat(64),
      allowed_tools: [],
      autonomy_level: 'L2',
      max_budget_usd: '1',
      max_iterations: 10,
      max_duration_min: 10,
      loop_threshold: 5,
      allowed_models: ['m'],
      egress_allowlist: ['litellm:4000'],
      issued_at: '2026-10-14T08:00:00.000Z',
      expires_at: '2026-10-14T08:30:00.000Z',
    };
    expect(validateRunContract(run).ok).toBe(true);
    expect(validateEvaluationContract(run).ok).toBe(false);
    expect(
      parseRunContractEnvelope({ contract: evaluation, signature: 'vault:v1:AAAA' }),
    ).toBeUndefined();
    expect(
      parseEvaluationContractEnvelope({ contract: run, signature: 'vault:v1:AAAA' }),
    ).toBeUndefined();
  });

  it('the signed bytes carry the kind, so a signature of one is no signature of the other', () => {
    const bytes = Buffer.from(evaluationContractBytes(contract())).toString('utf8');
    expect(bytes).toContain('"kind":"evaluation"');
    expect(Buffer.from(runContractBytes(contract() as never)).toString('utf8')).toBe(bytes);
    expect(evaluationContractSha256(contract())).toMatch(/^[0-9a-f]{64}$/);
    expect(evaluationContractSha256(contract({ attempt: 2 }))).not.toBe(
      evaluationContractSha256(contract()),
    );
  });
});

describe('the envelope', () => {
  it('has exactly a contract and a Transit signature', () => {
    const ok = parseEvaluationContractEnvelope({
      contract: contract(),
      signature: 'vault:v3:AAAA',
    });
    expect(ok).toMatchObject({ keyVersion: 3, signature: 'vault:v3:AAAA' });
    for (const bad of [
      { contract: contract() },
      { contract: contract(), signature: 'AAAA' },
      { contract: contract(), signature: 'vault:v0:AAAA' },
      { contract: contract(), signature: 'vault:v1:AAAA', extra: 1 },
      { contract: { ...contract(), attempt: 0 }, signature: 'vault:v1:AAAA' },
      null,
      [],
    ]) {
      expect(parseEvaluationContractEnvelope(bad)).toBeUndefined();
    }
  });
});
