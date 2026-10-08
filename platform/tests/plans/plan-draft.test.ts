// S02 (D-08 S02 AC1–AC4, ADR-M62, QUESTIONS #295–#297): a plan file draft from a Spec Kit task list
// or a BMAD story file. The draft is schema version 1, fails submission with `schema_invalid` until
// a person fills the marked fields, and passes `parsePlanFile` once they are filled. Fixtures follow
// the pinned tools' formats (Spec Kit v1.1.2, BMAD v6.12.1; ADR-M61 §2.2).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readYamlMapping } from '@sdlc/config';
import { describe, expect, it } from 'vitest';

import {
  DRAFT_CHECK_VALUES,
  draftPlan,
  parsePlanFile,
  readPlanTaskTexts,
  type PlanDraft,
} from '../../packages/core/src/plans/index.js';

const CODE = 'INT-2026-0007';
const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8');
const specFixture = (name: string): string =>
  readFileSync(join(__dirname, '..', 'specs', 'fixtures', name), 'utf8');

function ok(result: PlanDraft): Extract<PlanDraft, { ok: true }> {
  if (!result.ok) throw new Error(`refused: ${result.refusal} ${result.planRefusal ?? ''}`);
  return result;
}

/** What a person does: fill the marked fields. */
function fill(yaml: string): string {
  return yaml
    .replace(/allowed_paths: null/g, 'allowed_paths: [apps/api/src/orders/**]')
    .replace(/tools: null/g, 'tools: [file_editor, terminal]')
    .replace(/change_flags: null/, 'change_flags: []');
}

function tasksOf(yaml: string): Record<string, unknown>[] {
  const read = readYamlMapping(yaml, { maxAliasCount: 0 });
  if (!read.ok) throw new Error('not YAML');
  return read.value.tasks as Record<string, unknown>[];
}

function specKitItems(phases: number, perPhase: number): string {
  const lines = ['# Tasks: Large feature', ''];
  let n = 1;
  for (let p = 1; p <= phases; p += 1) {
    lines.push(`## Phase ${p}: Part ${p}`, '');
    for (let i = 0; i < perPhase; i += 1) {
      const id = `T${String(n).padStart(3, '0')}`;
      const dep = n > 1 && i === 0 ? ` (depends on T${String(n - 1).padStart(3, '0')})` : '';
      lines.push(`- [ ] ${id} Change apps/api/src/part${p}/file${i}.ts${dep}`);
      n += 1;
    }
    lines.push('', `**Checkpoint**: Part ${p} works`, '');
  }
  return lines.join('\n');
}

describe('sdlc plan draft: Spec Kit tasks.md', () => {
  const draft = ok(
    draftPlan({ text: fixture('spec-kit-tasks-filled.md'), tool: 'spec-kit', intentCode: CODE }),
  );

  it('writes one task per item, with summary, dependencies and the phase checkpoint (AC1)', () => {
    expect(draft.tasks).toBe(6);
    expect(draft.grouped).toBe(false);
    const tasks = tasksOf(draft.yaml);
    expect(tasks.map((task) => task.id)).toEqual(['T001', 'T002', 'T003', 'T004', 'T005', 'T006']);
    expect(tasks[1]!.summary).toBe(
      'Add a `status` query parameter to apps/api/src/orders/orders.controller.ts',
    );
    expect(tasks[2]!.depends_on).toEqual(['T001', 'T002']);
    expect(tasks[2]!.checkpoint).toBe('The API filters orders by status');
    expect(tasks[0]!.checkpoint).toBeUndefined();
    expect(tasks[5]!.checkpoint).toBe('User Story 1 works on its own');
    expect(draft.yaml).not.toContain('T998');
    expect(draft.yaml).not.toContain('T999');
  });

  it('leaves the fields a person decides null, so submission refuses the draft (AC2)', () => {
    const tasks = tasksOf(draft.yaml);
    for (const task of tasks) {
      expect(task.allowed_paths).toBeNull();
      expect(task.tools).toBeNull();
    }
    expect(draft.yaml).toMatch(/^ {2}change_flags: null$/m);
    expect(draft.yaml).toContain('# PERSON MUST FILL');
    expect(draft.yaml).toContain('# PERSON MUST DECIDE');
    expect(parsePlanFile(draft.yaml, CODE)).toEqual({ ok: false, reason: 'schema_invalid' });
    expect(draft.unfilled).toEqual([
      'plan.change_flags',
      ...[0, 1, 2, 3, 4, 5].flatMap((i) => [`tasks[${i}].allowed_paths`, `tasks[${i}].tools`]),
    ]);
  });

  it('passes submission once the marked fields are filled (AC3)', () => {
    const filled = parsePlanFile(fill(draft.yaml), CODE);
    expect(filled).toEqual({
      ok: true,
      plan: {
        plannedFiles: ['apps/api/src/orders/**'],
        allowedTools: ['file_editor', 'terminal'],
        changeFlags: [],
      },
    });
  });

  it('keeps the task text exactly, also YAML signs and Japanese text (no injection)', () => {
    const texts = readPlanTaskTexts(fill(draft.yaml), CODE);
    if (!texts.ok) throw new Error(texts.reason);
    const summary = (id: string): string | undefined =>
      texts.tasks.find((task) => task.id === id)?.fields.find((f) => f.name === 'summary')
        ?.values[0];
    expect(summary('T004')).toBe(
      'Unit test in apps/api/test/orders/orders.service.spec.ts: "received" → 受付; key: value # not a comment',
    );
    expect(summary('T006')).toBe(
      'Do not touch .github/workflows/ci.yml or AGENTS.md; keep *alias &anchor !tag text as text',
    );
  });

  it('suggests named paths as comments only, never protected ones (QUESTIONS #297)', () => {
    expect(draft.yaml).toContain('    #   apps/api/src/orders/orders.service.ts');
    expect(draft.yaml).not.toMatch(/^\s*#\s+\.github\//m);
    expect(draft.yaml).not.toMatch(/^\s*#\s+AGENTS\.md/m);
    for (const task of tasksOf(draft.yaml)) expect(task.allowed_paths).toBeNull();
  });

  it('never writes the in-memory values of the self-check', () => {
    expect(draft.yaml).not.toContain(DRAFT_CHECK_VALUES.allowedPaths[0]);
    expect(draft.yaml).not.toMatch(/^\s*tools: \[/m);
    expect(draft.yaml).not.toMatch(/^\s*change_flags: \[/m);
  });

  it('refuses a task list that still holds template text', () => {
    expect(
      draftPlan({
        text: fixture('spec-kit-tasks-template.md'),
        tool: 'spec-kit',
        intentCode: CODE,
      }),
    ).toEqual({ ok: false, refusal: 'template_text' });
  });

  it('refuses a file without a task list', () => {
    expect(
      draftPlan({ text: specFixture('spec-kit-filled.md'), tool: 'spec-kit', intentCode: CODE }),
    ).toEqual({ ok: false, refusal: 'no_tasks' });
  });

  it('groups by phase above 20 items, and refuses above 20 phases (QUESTIONS #295)', () => {
    const twenty = ok(draftPlan({ text: specKitItems(4, 5), tool: 'spec-kit', intentCode: CODE }));
    expect(twenty.grouped).toBe(false);
    expect(twenty.tasks).toBe(20);

    const grouped = ok(draftPlan({ text: specKitItems(3, 7), tool: 'spec-kit', intentCode: CODE }));
    expect(grouped.grouped).toBe(true);
    const tasks = tasksOf(grouped.yaml);
    expect(tasks.map((task) => task.id)).toEqual(['Phase1', 'Phase2', 'Phase3']);
    expect(tasks[1]!.summary).toBe('Phase 2: Part 2');
    expect(tasks[1]!.depends_on).toEqual(['Phase1']);
    expect(tasks[1]!.definition_of_done).toHaveLength(7);
    expect((tasks[1]!.definition_of_done as string[])[0]).toBe(
      'T008 Change apps/api/src/part2/file0.ts (depends on T007)',
    );
    expect(tasks[2]!.checkpoint).toBe('Part 3 works');
    expect(grouped.yaml).toContain('one plan task per phase');
    expect(parsePlanFile(fill(grouped.yaml), CODE).ok).toBe(true);

    expect(draftPlan({ text: specKitItems(21, 1), tool: 'spec-kit', intentCode: CODE })).toEqual({
      ok: false,
      refusal: 'too_many_tasks',
    });
  });

  it('refuses a draft larger than 64 KiB', () => {
    const long = 'x'.repeat(1900);
    const items = (checkpoints: boolean): string =>
      Array.from({ length: 20 }, (_, i) =>
        [
          `## Phase ${i + 1}: Part`,
          `- [ ] T${100 + i} ${long}`,
          checkpoints ? `**Checkpoint**: ${long}` : '',
        ].join('\n'),
      ).join('\n');
    expect(draftPlan({ text: items(true), tool: 'spec-kit', intentCode: CODE })).toEqual({
      ok: false,
      refusal: 'draft_too_large',
    });
    expect(draftPlan({ text: items(false), tool: 'spec-kit', intentCode: CODE }).ok).toBe(true);
  });

  it('reports a draft submission would refuse with the submission reason', () => {
    // The same task ID twice: the schema needs unique IDs.
    const text = '- [ ] T001 Change apps/api/src/a.ts\n- [ ] T001 Change apps/api/src/b.ts\n';
    expect(draftPlan({ text, tool: 'spec-kit', intentCode: CODE })).toEqual({
      ok: false,
      refusal: 'draft_check_failed',
      planRefusal: 'schema_invalid',
    });
  });

  it('refuses a task whose text is only control or bidirectional characters', () => {
    const text = '- [ ] T001 Change apps/api/src/a.ts\n- [ ] T002 \u202e\u202e\u0007\n';
    expect(draftPlan({ text, tool: 'spec-kit', intentCode: CODE })).toEqual({
      ok: false,
      refusal: 'template_text',
    });
  });

  it('removes characters YAML does not allow (U+FFFE, U+FFFF)', () => {
    const text = '- [ ] T001 Change \ufffe the \uffff file\n';
    const yaml = ok(draftPlan({ text, tool: 'spec-kit', intentCode: CODE })).yaml;
    expect(yaml).not.toMatch(/[\ufffe\uffff]/);
    expect(tasksOf(yaml)[0]!.summary).toBe('Change the file');
  });

  it('never suggests a protected folder or instruction file at any depth', () => {
    const text =
      '- [ ] T001 Touch src/.github/x/y, a/b/.sdlc/c, AGENTS.md/x, docs/AGENTS.md and src/ok/file.ts\n';
    const yaml = ok(draftPlan({ text, tool: 'spec-kit', intentCode: CODE })).yaml;
    const hints = yaml.split('\n').filter((line) => line.startsWith('    #   '));
    expect(hints).toEqual(['    #   src/ok/file.ts']);
  });

  it('removes control and bidirectional characters and caps each value', () => {
    const text = `- [ ] T001 Change‮ the\u0007 file ${'y'.repeat(3000)}`;
    const tasks = tasksOf(ok(draftPlan({ text, tool: 'spec-kit', intentCode: CODE })).yaml);
    const summary = tasks[0]!.summary as string;
    expect(summary.startsWith('Change the file yyy')).toBe(true);
    expect([...summary]).toHaveLength(2000);
  });
});

describe('sdlc plan draft: BMAD story file', () => {
  it('writes one task per top-level item, subtasks in definition_of_done (AC1)', () => {
    const draft = ok(
      draftPlan({ text: fixture('bmad-story-tasks.md'), tool: 'bmad', intentCode: CODE }),
    );
    const tasks = tasksOf(draft.yaml);
    expect(tasks.map((task) => task.id)).toEqual(['Task1', 'Task2']);
    expect(tasks[0]!.summary).toBe('Add a threshold column to products (AC: 2)');
    expect(tasks[0]!.definition_of_done).toEqual([
      'Migration with the default 10',
      'Show the threshold on the product form',
    ]);
    expect(tasks[1]!.definition_of_done).toEqual(['在庫が閾値未満なら警告を表示する']);
    expect(tasks[0]!.depends_on).toBeUndefined();
    expect(parsePlanFile(draft.yaml, CODE)).toEqual({ ok: false, reason: 'schema_invalid' });
    expect(parsePlanFile(fill(draft.yaml), CODE).ok).toBe(true);
  });

  it('refuses the epics file: one intent is one story (QUESTIONS #296)', () => {
    expect(
      draftPlan({ text: specFixture('bmad-epics-filled.md'), tool: 'bmad', intentCode: CODE }),
    ).toEqual({ ok: false, refusal: 'epics_file' });
  });

  it('refuses the story template and a story without tasks', () => {
    for (const name of ['bmad-story-template.md', 'bmad-story-filled.md']) {
      expect(draftPlan({ text: specFixture(name), tool: 'bmad', intentCode: CODE })).toEqual({
        ok: false,
        refusal: 'template_text',
      });
    }
    expect(
      draftPlan({ text: specFixture('manual-no-criteria.md'), tool: 'bmad', intentCode: CODE }),
    ).toEqual({ ok: false, refusal: 'no_tasks' });
  });

  it('refuses more than 20 tasks', () => {
    const items = Array.from({ length: 21 }, (_, i) => `- [ ] Change part ${i}`).join('\n');
    expect(
      draftPlan({ text: `## Tasks / Subtasks\n\n${items}\n`, tool: 'bmad', intentCode: CODE }),
    ).toEqual({ ok: false, refusal: 'too_many_tasks' });
  });
});
