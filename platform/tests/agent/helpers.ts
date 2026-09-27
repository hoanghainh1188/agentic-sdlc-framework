// Shared values for the agent adapter tests (D-08 C05, ADR-M29).
import type { AgentTask, RedactedSecret, RunContract } from '@sdlc/contracts';

export const RUN_ID = '11111111-1111-4111-8111-111111111111';
export const CONVERSATION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
export const SESSION_KEY = 'session-key-for-tests-0123456789abcdef';
export const VIRTUAL_KEY = 'sk-virtual-key-canary-0123456789';

export function secret(value: string): RedactedSecret {
  return { reveal: () => value, toString: () => '[redacted]' } as RedactedSecret;
}

export const CONTRACT: RunContract = {
  schema_version: 1,
  run_id: RUN_ID,
  intent_id: '22222222-2222-4222-8222-222222222222',
  tenant_id: '33333333-3333-4333-8333-333333333333',
  project_id: '44444444-4444-4444-8444-444444444444',
  repo: 'org/pilot-order-inventory',
  base_sha: 'a'.repeat(40),
  branch: 'agent/INT-2026-0001',
  plan_id: '55555555-5555-4555-8555-555555555555',
  plan_sha256: 'b'.repeat(64),
  planned_files: ['apps/web/src/products/**', 'docs/CHANGELOG.md'],
  agent_id: '66666666-6666-4666-8666-666666666666',
  agent_version: '1.0.0',
  instructions_sha256: 'c'.repeat(64),
  allowed_tools: ['file_editor', 'terminal'],
  autonomy_level: 'L2',
  max_budget_usd: '1',
  max_iterations: 30,
  max_duration_min: 60,
  loop_threshold: 3,
  allowed_models: ['gpt-oss-20b', 'stub-model'],
  egress_allowlist: ['litellm:4000', 'npm-proxy:4873'],
  issued_at: '2026-09-27T08:00:00.000Z',
  expires_at: '2026-09-27T08:15:00.000Z',
};

export const TASK: AgentTask = {
  spec: {
    path: 'docs/specs/T01-japanese-labels.md',
    commitSha: 'd'.repeat(40),
    contentSha256: 'e'.repeat(64),
  },
  plan: {
    summary: 'Add Japanese labels to the product list screen.',
    plannedFiles: ['apps/web/src/products/**', 'docs/CHANGELOG.md'],
  },
};
