// D-08 L09 (QUESTIONS #501): in an evaluation of a plan the agent gets its own tools, as the
// evaluation recorded them at its start; an operator evaluation (L04) keeps the tools of the
// harness. The contract view is checked like any Run Contract.
import type { EvaluationRunContract } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import {
  agentContractOf,
  EVALUATION_AGENT_TOOLS,
} from '../../apps/runner/src/evaluation/agent-contract.js';

const contract: EvaluationRunContract = {
  schema_version: 3,
  kind: 'evaluation',
  evaluation_run_id: '11111111-1111-4111-8111-111111111111',
  evaluation_id: '22222222-2222-4222-8222-222222222222',
  evaluation_code: 'EVAL-2026-0001',
  tenant_id: '33333333-3333-4333-8333-333333333333',
  project_id: '44444444-4444-4444-8444-444444444444',
  repo: 'org/pilot-order-inventory',
  base_sha: 'a'.repeat(40),
  configuration_id: 'next',
  task_id: 'feat-tax',
  task_set_kind: 'folder',
  task_set_version: 1,
  task_set_commit: null,
  run_index: 1,
  attempt: 1,
  agent_version: '1.1.0',
  agent_adapter: 'openhands',
  model: 'qwen3-8b',
  max_budget_usd: '2',
  max_iterations: 30,
  max_duration_min: 20,
  loop_threshold: 3,
  allowed_models: ['qwen3-8b'],
  egress_allowlist: ['litellm:4000'],
  issued_at: '2026-10-20T08:00:00.000Z',
  expires_at: '2026-10-20T10:00:00.000Z',
};

const input = { contract, baseSha: 'b'.repeat(40), plannedFiles: ['src/tax.ts'] };

describe('L09: the tools of the agent in an evaluation', () => {
  it('an operator evaluation keeps the tools of the harness', () => {
    const view = agentContractOf({ ...input, instructionsSha256: 'c'.repeat(64) });
    expect(view.allowed_tools).toEqual([...EVALUATION_AGENT_TOOLS]);
  });

  it('an evaluation of a plan gives the agent the tools of its configuration', () => {
    const view = agentContractOf({
      ...input,
      instructionsSha256: 'c'.repeat(64),
      allowedTools: ['file_editor', 'task_tracker', 'terminal'],
    });
    expect(view.allowed_tools).toEqual(['file_editor', 'task_tracker', 'terminal']);
    expect(view.instructions_sha256).toBe('c'.repeat(64));
  });
});
