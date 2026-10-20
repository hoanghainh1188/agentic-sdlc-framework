// D-08 L07 PR 4a (design/ADR-M85 §2.5, QUESTIONS #488): the contract of a task check, a third
// kind of Run Contract, and the workflow ID of a check attempt.
import {
  evaluationTaskCheckWorkflowId,
  parseTaskCheckContractEnvelope,
  TASK_CHECK_CONTRACT_FIELDS,
  validateTaskCheckContract,
  validateEvaluationContract,
  type TaskCheckContract,
} from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

const UUID = '0b0e4c8a-6d4f-4e5c-9a3b-2f1d0c9b8a7e';
const CONTRACT: TaskCheckContract = {
  schema_version: 1,
  kind: 'evaluation_task_check',
  evaluation_task_id: UUID,
  tenant_id: UUID,
  project_id: UUID,
  repo: 'org/shop',
  task_id: 'tax-rule',
  card_commit: '3'.repeat(40),
  card_sha256: 'a'.repeat(64),
  base_sha: '1'.repeat(40),
  merge_sha: '2'.repeat(40),
  attempt: 1,
  issued_at: '2026-10-20T08:00:00.000Z',
  expires_at: '2026-10-20T09:00:00.000Z',
};

describe('the task check contract (QUESTIONS #488)', () => {
  it('accepts a valid contract and names its fields in schema order', () => {
    expect(validateTaskCheckContract(CONTRACT)).toEqual({ ok: true, contract: CONTRACT });
    expect(TASK_CHECK_CONTRACT_FIELDS[1]).toBe('kind');
  });

  it.each([
    ['an extra field (a path)', { ...CONTRACT, spec_path: 'docs/x.md' }, 'spec_path'],
    ['another kind', { ...CONTRACT, kind: 'evaluation' }, 'kind'],
    ['a short card hash', { ...CONTRACT, card_sha256: 'abc' }, 'card_sha256'],
    ['the same two commits', { ...CONTRACT, merge_sha: CONTRACT.base_sha }, 'merge_sha'],
    ['an expiry before the issue', { ...CONTRACT, expires_at: CONTRACT.issued_at }, 'expires_at'],
    ['attempt 0', { ...CONTRACT, attempt: 0 }, 'attempt'],
  ])('refuses %s', (_name, value, field) => {
    expect(validateTaskCheckContract(value)).toEqual({ ok: false, field });
  });

  it('is never taken for an evaluation contract, nor the other way round', () => {
    expect(validateEvaluationContract(CONTRACT).ok).toBe(false);
  });

  it('parses an envelope with a vault signature only', () => {
    expect(
      parseTaskCheckContractEnvelope({ contract: CONTRACT, signature: 'vault:v2:QUJD' }),
    ).toEqual({ contract: CONTRACT, signature: 'vault:v2:QUJD', keyVersion: 2 });
    expect(parseTaskCheckContractEnvelope({ contract: CONTRACT, signature: 'x' })).toBeUndefined();
    expect(
      parseTaskCheckContractEnvelope({ contract: CONTRACT, signature: 'vault:v1:QQ==', x: 1 }),
    ).toBeUndefined();
  });

  it('names a check attempt in its workflow ID, and refuses malformed parts', () => {
    const ref = { tenantId: UUID, evaluationTaskId: UUID, cardSha256: 'a'.repeat(64), attempt: 2 };
    expect(evaluationTaskCheckWorkflowId(ref)).toBe(
      `evaluation-task-check/${UUID}/${UUID}/${'a'.repeat(64)}/2`,
    );
    expect(() => evaluationTaskCheckWorkflowId({ ...ref, cardSha256: 'x' })).toThrow();
    expect(() => evaluationTaskCheckWorkflowId({ ...ref, attempt: 0 })).toThrow();
  });
});
