// B09 (ADR-M40 §2.2, QUESTIONS #165): what a plan file may be, and how it is read and hashed.
// The patterns use the glob language of the G5 scope check (`checkScope`), so the tests below also
// show that a refused pattern is one G5 would match.
import { createHash } from 'node:crypto';

import { GitHostError } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import {
  parsePlanFile,
  patternRefusal,
  PLAN_MAX_BYTES,
  planFileSha256,
  planPath,
  readPlanFile,
} from '../../packages/core/src/plans/index.js';

const CODE = 'INT-2026-0007';

function plan(lines: { plan?: string[]; tasks?: string[] } = {}): string {
  return [
    'plan:',
    `  intent_id: ${CODE}`,
    ...(lines.plan ?? []),
    'tasks:',
    ...(lines.tasks ?? [
      '  - id: T1',
      '    summary: Cancel an order and return the stock',
      '    owner_agent: coder',
      '    depends_on: []',
      '    input: spec AC1-AC3',
      '    output: code and tests',
      '    allowed_paths: [apps/api/src/orders/**, apps/api/test/orders/**]',
      '    tools: [file_editor, terminal]',
      '    environments: [sandbox]',
      '    definition_of_done: [AC1 has a passing test]',
      '    required_evidence: [unit_tests]',
      '    escalate_when: [a change outside allowed_paths is needed]',
      '    checkpoint: after each passing test run',
    ]),
    '',
  ].join('\n');
}

describe('parsePlanFile (schema version 1, template T13)', () => {
  it('keeps the union of path patterns and tools, and the flags, sorted', () => {
    const text = plan({
      plan: ['  change_flags: [personal_data, migration, migration]', '  adr_refs: [ADR-0003]'],
      tasks: [
        '  - id: T1',
        '    allowed_paths: [apps/web/**, apps/api/src/**]',
        '    tools: [terminal, file_editor]',
        '  - id: T-2',
        '    allowed_paths: [apps/api/src/**, docs/orders.md]',
        '    tools: [task_tracker]',
      ],
    });
    expect(parsePlanFile(text, CODE)).toEqual({
      ok: true,
      plan: {
        plannedFiles: ['apps/api/src/**', 'apps/web/**', 'docs/orders.md'],
        allowedTools: ['file_editor', 'task_tracker', 'terminal'],
        changeFlags: ['migration', 'personal_data'],
      },
    });
  });

  it('accepts the documentation fields of T13 without keeping them', () => {
    const parsed = parsePlanFile(plan(), CODE);
    expect(parsed.ok).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain('Cancel an order');
  });

  it.each<[string, string]>([
    ['plan: [\n', 'yaml_invalid'],
    ['plan:\n  intent_id: a\n  intent_id: b\ntasks: []\n', 'yaml_invalid'],
    [`base: &b\n  intent_id: ${CODE}\nplan: *b\ntasks: []\n`, 'yaml_invalid'],
    ['', 'schema_invalid'],
    ['- just a list\n', 'yaml_invalid'],
    [plan({ tasks: [] }), 'schema_invalid'],
    [`plan:\n  intent_id: ${CODE}\n`, 'schema_invalid'],
    [plan({ plan: ['  owner: alice'] }), 'schema_invalid'],
    [plan({ plan: ['  change_flags: [big_change]'] }), 'schema_invalid'],
    [plan({ plan: ['  approved_by: bob'] }), 'platform_field'],
    [plan({ plan: ['  approved_at: 2026-10-03'] }), 'platform_field'],
    [plan({ plan: ['  risk_tier: low'] }), 'platform_field'],
    [plan({ plan: ['  data_class: internal'] }), 'platform_field'],
    [plan({ plan: ['  autonomy_level: L2'] }), 'platform_field'],
    [plan({ plan: ['  plan_version: 1'] }), 'platform_field'],
    [plan({ plan: ['  spec_version: v2'] }), 'platform_field'],
    [
      plan({
        tasks: [
          '  - id: T1',
          '    allowed_paths: [a/**]',
          '    tools: [terminal]',
          '    limits: {}',
        ],
      }),
      'platform_field',
    ],
    [
      plan({ tasks: ['  - id: T1', '    allowed_paths: [a/**]', '    tools: [read_repo]'] }),
      'unknown_tool',
    ],
    [
      plan({ tasks: ['  - id: T1', '    allowed_paths: [a/**]', '    tools: []'] }),
      'schema_invalid',
    ],
    [
      plan({
        tasks: [
          '  - id: T1',
          '    allowed_paths: [a/**]',
          '    tools: [terminal]',
          '    environments: [production]',
        ],
      }),
      'schema_invalid',
    ],
    [
      plan({
        tasks: [
          '  - id: T1',
          '    allowed_paths: [a/**]',
          '    tools: [terminal]',
          '  - id: T1',
          '    allowed_paths: [b/**]',
          '    tools: [terminal]',
        ],
      }),
      'schema_invalid',
    ],
    [
      plan({
        tasks: ['  - id: T1', '    allowed_paths: [a/**]', '    tools: [terminal]', '    x: 1'],
      }),
      'schema_invalid',
    ],
    [
      plan({ tasks: ['  - id: T1', '    allowed_paths: ["**"]', '    tools: [terminal]'] }),
      'pattern_too_broad',
    ],
  ])('refuses %j → %s', (text, reason) => {
    expect(parsePlanFile(text, CODE)).toEqual({ ok: false, reason });
  });

  it('refuses a plan of another intent', () => {
    expect(parsePlanFile(plan(), 'INT-2026-0008')).toEqual({
      ok: false,
      reason: 'intent_mismatch',
    });
  });

  it('refuses more than 1000 distinct path patterns, more than 20 tasks or 200 paths in a task', () => {
    const task = (i: number, paths: number) => [
      `  - id: T${String(i)}`,
      '    allowed_paths:',
      ...Array.from({ length: paths }, (_, j) => `      - src/t${String(i)}/p${String(j)}/**`),
      '    tools: [terminal]',
    ];
    const many = Array.from({ length: 6 }, (_, i) => task(i, 200)).flat();
    expect(parsePlanFile(plan({ tasks: many }), CODE)).toEqual({
      ok: false,
      reason: 'too_many_paths',
    });
    expect(parsePlanFile(plan({ tasks: task(1, 201) }), CODE)).toMatchObject({ ok: false });
    const tasks = Array.from({ length: 21 }, (_, i) => task(i, 1)).flat();
    expect(parsePlanFile(plan({ tasks }), CODE)).toEqual({ ok: false, reason: 'schema_invalid' });
  });
});

describe('patternRefusal (QUESTIONS #165)', () => {
  it.each([
    'apps/api/src/orders/**',
    'apps/api/src/orders/service.ts',
    'apps/*/src/orders/*.ts',
    'docs/specs/T07.md',
    'README.md',
    'apps/web/src/{orders,stock}/**',
    'src/.eslintrc.json',
  ])('accepts %j', (pattern) => expect(patternRefusal(pattern)).toBeNull());

  it.each(['**', '*', '*/**', '**/*', '*.*', '*/*', '**/*.*', '{apps,**}/**'])(
    'refuses %j as too broad',
    (pattern) => expect(patternRefusal(pattern)).toBe('pattern_too_broad'),
  );

  it.each([
    '.github/workflows/**',
    '.github/**',
    '.GitHub/CODEOWNERS',
    '.git*/**',
    '{.github,apps}/**',
    '.sdlc/plans/INT-2026-0007.yaml',
    '.sdlc/**',
    'AGENTS.md',
    'agents.md',
    'CLAUDE.md',
    '.cursorrules',
    '*.md',
    'apps/api/AGENTS.md',
    'apps/**/AGENTS.md',
    '.openhands/microagents/**',
    '.agents/skills/review.md',
  ])('refuses %j as a protected path', (pattern) => {
    expect(patternRefusal(pattern)).toBe('protected_path');
  });

  it.each(['/etc/**', '../x/**', 'a/../b', 'a//b', './a', 'a\\b', '', 'a/'])(
    'refuses %j as an invalid pattern',
    (pattern) => expect(patternRefusal(pattern)).toBe('invalid_pattern'),
  );
});

describe('readPlanFile', () => {
  const ref = { owner: 'acme', name: 'shop' };
  const host = (result: string | GitHostError) => ({
    calls: [] as string[],
    getFileAtCommit(_ref: unknown, path: string) {
      this.calls.push(path);
      return result instanceof GitHostError ? Promise.reject(result) : Promise.resolve(result);
    },
  });

  it('reads .sdlc/plans/<code>.yaml and hashes its bytes', async () => {
    const text = plan();
    const git = host(text);
    const read = await readPlanFile(git, ref, CODE, 'a'.repeat(40));
    expect(git.calls).toEqual([planPath(CODE)]);
    expect(planPath(CODE)).toBe('.sdlc/plans/INT-2026-0007.yaml');
    expect(read).toEqual({
      kind: 'ok',
      text,
      sha256: createHash('sha256').update(text).digest('hex'),
    });
    expect(planFileSha256(text)).toBe(createHash('sha256').update(text).digest('hex'));
  });

  it.each<[GitHostError | string, string]>([
    [new GitHostError('not_found'), 'missing'],
    [new GitHostError('not_a_file'), 'not_a_file'],
    [new GitHostError('file_too_large'), 'too_large'],
    [new GitHostError('file_not_utf8'), 'not_utf8'],
    ['x'.repeat(PLAN_MAX_BYTES + 1), 'too_large'],
  ])('a file that cannot be read → %s', async (result, cause) => {
    expect(await readPlanFile(host(result), ref, CODE, 'a'.repeat(40))).toEqual({
      kind: 'unreadable',
      cause,
    });
  });

  it('a Git host failure is thrown, never taken as a fact about the file', async () => {
    await expect(
      readPlanFile(host(new GitHostError('server_error')), ref, CODE, 'a'.repeat(40)),
    ).rejects.toBeInstanceOf(GitHostError);
  });
});
