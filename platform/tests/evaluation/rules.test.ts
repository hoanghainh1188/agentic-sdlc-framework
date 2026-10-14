// The pure rules of evaluations on the server (task L04, design/ADR-M81 §2.2–§2.7): the checks of a
// new evaluation and of a result before the database sees them, the code format, the audit
// payloads (IDs and codes only) and the operator command's arguments. The database side is in
// tests/integration/db/evaluations.test.ts.
import { describe, expect, it } from 'vitest';

import { parseEvalCommand } from '../../apps/cli/src/commands/ops-eval.js';
import { checkAuditEvent } from '../../packages/core/src/audit/actions.js';
import { DbError } from '../../packages/core/src/db/errors.js';
import {
  checkEvaluationRunResult,
  type NewEvaluationRunResult,
} from '../../packages/core/src/db/repositories/evaluation-runs.js';
import {
  checkNewEvaluation,
  formatEvaluationCode,
  MAX_EVALUATION_RUNS,
  type NewEvaluation,
} from '../../packages/core/src/db/repositories/evaluations.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const evaluation = (over: Partial<NewEvaluation> = {}): NewEvaluation => ({
  projectId: PROJECT,
  dataClass: 'internal',
  taskSetVersion: 1,
  configName: 'local',
  baseSha: '7'.repeat(40),
  taskIds: ['feat-tax', 'bug-merge-order'],
  configurations: [
    {
      id: 'gpt-oss-20b',
      model: 'gpt-oss-20b',
      providerType: 'self_hosted',
      agentVersion: '1.0.0',
      maxIterations: 30,
      maxDurationMin: 20,
    },
  ],
  runsPerTask: 5,
  budgetUsd: '2.5',
  startedBy: null,
  ...over,
});
const result = (over: Partial<NewEvaluationRunResult> = {}): NewEvaluationRunResult => ({
  instructions_sha256: 'a'.repeat(64),
  outcome: 'finished',
  status: 'succeeded',
  stop_reason: null,
  applied: true,
  resolved: true,
  fail_to_pass_passed: true,
  pass_to_pass_passed: true,
  ci_passed: true,
  scope_breach: false,
  out_of_plan_files: 0,
  lint_findings: 0,
  diff_files: 1,
  diff_lines_added: 3,
  diff_lines_removed: 0,
  seconds: 30,
  iterations: 4,
  model_calls: 4,
  input_tokens: 100,
  output_tokens: 20,
  cached_input_tokens: 0,
  cost_usd: '0.001200',
  hardware: {
    cpu_model: 'Apple M4 Pro',
    cpu_cores: 12,
    memory_gb: 24,
    docker_version: '29.8.2',
    gpu: null,
    runner_instance: 'runner-1',
  },
  ...over,
});

describe('a new evaluation is checked before the database sees it', () => {
  it('accepts a normal one', () => {
    expect(() => checkNewEvaluation(evaluation())).not.toThrow();
  });

  it.each([
    ['a project that is not a UUID', { projectId: 'shop' }],
    ['prohibited data', { dataClass: 'prohibited' as const }],
    ['an unknown data class', { dataClass: 'secret' as never }],
    ['task set version 0', { taskSetVersion: 0 }],
    ['a config name with a path', { configName: '../local' }],
    ['a base commit that is a branch name', { baseSha: 'main' }],
    ['no task', { taskIds: [] }],
    ['a task code with capitals', { taskIds: ['Feat'] }],
    ['a repeated task', { taskIds: ['a', 'a'] }],
    ['runs per task above 50', { runsPerTask: 51 }],
    ['a budget of 0', { budgetUsd: '0' }],
    ['a budget with 7 decimals', { budgetUsd: '1.1234567' }],
    ['a person that is not a UUID', { startedBy: 'harry' }],
    [
      'a model with a space',
      {
        configurations: [
          {
            id: 'a',
            model: 'my model',
            providerType: 'api' as const,
            agentVersion: '1.0.0',
            maxIterations: 30,
            maxDurationMin: 20,
          },
        ],
      },
    ],
    [
      'an agent version that is a sentence',
      {
        configurations: [
          {
            id: 'a',
            model: 'm',
            providerType: 'api' as const,
            agentVersion: 'the new one',
            maxIterations: 30,
            maxDurationMin: 20,
          },
        ],
      },
    ],
    [
      `more than ${String(MAX_EVALUATION_RUNS)} runs`,
      {
        taskIds: Array.from({ length: 64 }, (_, i) => `t${String(i)}`),
        runsPerTask: 50,
        configurations: [
          {
            id: 'a',
            model: 'm',
            providerType: 'self_hosted' as const,
            agentVersion: '1.0.0',
            maxIterations: 30,
            maxDurationMin: 20,
          },
          {
            id: 'b',
            model: 'm',
            providerType: 'self_hosted' as const,
            agentVersion: '1.0.0',
            maxIterations: 30,
            maxDurationMin: 20,
          },
        ],
      },
    ],
  ])('refuses %s', (_name, over) => {
    expect(() => checkNewEvaluation(evaluation(over as Partial<NewEvaluation>))).toThrow(DbError);
  });

  it('formats the code as EVAL-YYYY-NNNN', () => {
    expect(formatEvaluationCode(2026, 1)).toBe('EVAL-2026-0001');
    expect(formatEvaluationCode(2026, 12345)).toBe('EVAL-2026-12345');
  });
});

describe('a result holds numbers and codes only', () => {
  it('accepts a scored result', () => {
    expect(() => checkEvaluationRunResult(result())).not.toThrow();
  });

  it.each([
    ['a sentence as the outcome', { outcome: 'it did not work' }],
    ['a short hash', { instructions_sha256: 'abc' }],
    ['a negative count', { lint_findings: -1 }],
    ['a fraction as a count', { seconds: 1.5 }],
    ['cached tokens above input tokens', { cached_input_tokens: 101 }],
    ['resolved without the hidden tests', { resolved: true, fail_to_pass_passed: false }],
    ['a float as money', { cost_usd: '1e-3' }],
    ['a hardware name with a newline', { hardware: { ...result().hardware, cpu_model: 'a\nb' } }],
    ['a runner label with spaces', { hardware: { ...result().hardware, runner_instance: 'a b' } }],
  ])('refuses %s', (_name, over) => {
    expect(() => checkEvaluationRunResult(result(over as Partial<NewEvaluationRunResult>))).toThrow(
      DbError,
    );
  });
});

describe('the audit events of an evaluation hold IDs and codes only', () => {
  it('accepts the declared fields and nothing else', () => {
    const entity = '22222222-2222-4222-8222-222222222222';
    expect(
      checkAuditEvent('evaluation.started', entity, {
        project_id: PROJECT,
        code: 'EVAL-2026-0001',
        data_class: 'internal',
        task_set_version: 1,
        config_name: 'local',
        runs_total: 20,
        budget_usd: '2.5',
      }).payload,
    ).toMatchObject({ code: 'EVAL-2026-0001' });
    expect(() =>
      checkAuditEvent('evaluation.started', entity, {
        project_id: PROJECT,
        code: 'EVAL-2026-0001',
        data_class: 'internal',
        task_set_version: 1,
        config_name: 'local',
        runs_total: 20,
        budget_usd: '2.5',
        prompt: 'fix the bug',
      }),
    ).toThrow(/undeclared/);
    expect(() =>
      checkAuditEvent('evaluation.finished', entity, {
        status: 'stopped_budget',
        runs_scored: 1,
        runs_failed: 0,
        runs_cancelled: 3,
        cost_usd: '1.1',
      }),
    ).not.toThrow();
  });
});

describe('sdlc ops eval start: arguments', () => {
  const base = [
    'start',
    '--tenant',
    'acme',
    '--project',
    'shop',
    '--config',
    'c.yaml',
    '--budget',
    '2',
  ];

  it('needs the tenant, the project, the configuration file and the budget', () => {
    expect(parseEvalCommand(base)).toMatchObject({ command: 'start' });
    for (const missing of ['--tenant', '--project', '--config', '--budget']) {
      const at = base.indexOf(missing);
      expect(parseEvalCommand(base.filter((_, i) => i !== at && i !== at + 1))).toBeUndefined();
    }
  });

  it('accepts the optional filters and refuses anything else', () => {
    expect(
      parseEvalCommand([
        ...base,
        '--tasks',
        'a,b',
        '--n',
        '3',
        '--data-class',
        'internal',
        '--json',
      ]),
    ).toBeDefined();
    expect(parseEvalCommand([...base, '--model', 'x'])).toBeUndefined();
    expect(parseEvalCommand(['stop', ...base.slice(1)])).toBeUndefined();
    expect(parseEvalCommand([])).toBeUndefined();
  });
});
