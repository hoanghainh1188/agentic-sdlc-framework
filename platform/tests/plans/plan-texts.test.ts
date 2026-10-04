// B09 PR 2 (ADR-M40 §2.7, QUESTIONS #169, #210): the agent-facing text of a plan file. Submission
// refuses a text field that is not text and names the field; the runner's reader skips and counts
// it instead, so a plan G3 approved never fails at run time for this.
import { describe, expect, it } from 'vitest';

import {
  PLAN_AGENT_TEXT_FIELDS,
  parsePlanFile,
  readPlanTaskTexts,
} from '../../packages/core/src/plans/index.js';

const CODE = 'INT-2026-0007';

function plan(tasks: string[]): string {
  return ['plan:', `  intent_id: ${CODE}`, 'tasks:', ...tasks, ''].join('\n');
}

const TASK = [
  '  - id: T1',
  '    summary: Cancel an order and return the stock',
  '    owner_agent: coder',
  '    input: spec AC1-AC3',
  '    output: code and tests',
  '    allowed_paths: [apps/api/src/orders/**]',
  '    tools: [file_editor, terminal]',
  '    definition_of_done: [AC1 has a passing test, 42, true]',
  '    required_evidence: [unit_tests]',
  '    escalate_when: [a change outside allowed_paths is needed]',
  '    depends_on: []',
  '    checkpoint: after each passing test run',
];

describe('readPlanTaskTexts (the runner)', () => {
  it('returns the agent-facing fields in a fixed order, scalars as text', () => {
    const read = readPlanTaskTexts(plan(TASK), CODE);
    expect(read).toMatchObject({ ok: true, skippedFields: 0 });
    if (!read.ok) return;
    expect(read.plan.plannedFiles).toEqual(['apps/api/src/orders/**']);
    expect(read.tasks).toEqual([
      {
        id: 'T1',
        fields: [
          { name: 'summary', values: ['Cancel an order and return the stock'], list: false },
          { name: 'input', values: ['spec AC1-AC3'], list: false },
          { name: 'output', values: ['code and tests'], list: false },
          {
            name: 'definition_of_done',
            values: ['AC1 has a passing test', '42', 'true'],
            list: true,
          },
          {
            name: 'escalate_when',
            values: ['a change outside allowed_paths is needed'],
            list: true,
          },
          { name: 'depends_on', values: [], list: true },
          { name: 'checkpoint', values: ['after each passing test run'], list: false },
        ],
      },
    ]);
  });

  it('never gives owner_agent or required_evidence to the agent', () => {
    expect(PLAN_AGENT_TEXT_FIELDS).not.toContain('owner_agent');
    expect(PLAN_AGENT_TEXT_FIELDS).not.toContain('required_evidence');
  });

  it('skips and counts a text field that is not text; an empty field is no field', () => {
    const text = plan([
      '  - id: T1',
      '    summary:',
      '      what: a mapping',
      '    input: [[nested]]',
      '    output:',
      '    allowed_paths: [apps/api/src/orders/**]',
      '    tools: [file_editor]',
    ]);
    const read = readPlanTaskTexts(text, CODE);
    expect(read).toMatchObject({ ok: true, skippedFields: 2 });
    if (read.ok) expect(read.tasks[0]?.fields).toEqual([]);
  });

  it('applies every other submission rule', () => {
    expect(readPlanTaskTexts(plan(TASK), 'INT-2026-0008')).toEqual({
      ok: false,
      reason: 'intent_mismatch',
    });
    expect(readPlanTaskTexts(plan(['  - id: T1', '    tools: [x]']), CODE)).toMatchObject({
      ok: false,
    });
  });
});

describe('parsePlanFile (submission): text fields must be text (QUESTIONS #210)', () => {
  it('refuses a mapping or a nested list with schema_invalid and the field path', () => {
    const second = [
      '  - id: T2',
      '    allowed_paths: [apps/web/**]',
      '    tools: [file_editor]',
      '    definition_of_done:',
      '      - [nested, list]',
    ];
    expect(parsePlanFile(plan([...TASK, ...second]), CODE)).toEqual({
      ok: false,
      reason: 'schema_invalid',
      field: 'tasks[1].definition_of_done',
    });
    const mapping = TASK.map((line) =>
      line.startsWith('    summary') ? '    summary: { a: b }' : line,
    );
    expect(parsePlanFile(plan(mapping), CODE)).toEqual({
      ok: false,
      reason: 'schema_invalid',
      field: 'tasks[0].summary',
    });
  });

  it('accepts scalars and lists of scalars, and the informative fields of any shape', () => {
    const text = plan([
      ...TASK.filter((l) => !l.includes('owner_agent')),
      '    owner_agent: { x: 1 }',
    ]);
    expect(parsePlanFile(text, CODE)).toMatchObject({ ok: true });
  });
});
