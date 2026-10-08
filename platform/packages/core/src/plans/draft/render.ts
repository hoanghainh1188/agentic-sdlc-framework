// Writing a plan draft as YAML, schema version 1 (task S02, ADR-M62 §2.2–§2.3, ADR-M40 §2.2).
//
// The fields a person must decide (`plan.change_flags`, each task's `allowed_paths` and `tools`)
// are written as `null` under a comment that says so (QUESTIONS #297). `null` fails submission with
// `schema_invalid` and, unlike a placeholder such as `TODO`, can never pass as a path pattern.
// Every text value is a JSON string, which is a valid YAML double-quoted scalar: no text from the
// task list can start a key, a comment, an anchor or a tag. Comments hold catalog text, the codes
// of the schema and suggested paths of safe characters only.
import { AGENT_TOOLS, CHANGE_FLAGS } from '@sdlc/contracts';
import { t, type MessageKey, type MessageParams } from '@sdlc/messages';

import type { DraftTask, DraftTool } from './types.js';

/** In-memory values of the self-check (ADR-M62 §2.3). Never written to a file. */
export const DRAFT_CHECK_VALUES = {
  allowedPaths: ['zz-sdlc-draft-check/**'],
  tools: ['file_editor'],
  changeFlags: [] as string[],
} as const;

export interface RenderInput {
  readonly intentCode: string;
  readonly tool: DraftTool;
  readonly tasks: readonly DraftTask[];
  readonly grouped: boolean;
  readonly locale?: string;
  /** True only for the self-check: the marked fields get `DRAFT_CHECK_VALUES`. */
  readonly checkValues?: boolean;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function list(values: readonly string[]): string {
  return `[${values.map(quote).join(', ')}]`;
}

export function renderDraft(input: RenderInput): string {
  const say = (key: MessageKey, params: MessageParams, indent: string): string[] =>
    t(key, params, input.locale)
      .split('\n')
      .map((line) => `${indent}# ${line}`);
  const fill = input.checkValues === true;
  const out: string[] = [
    ...say('plan.draft.file.header', { intent: input.intentCode, tool: input.tool }, ''),
    ...(input.grouped ? say('plan.draft.file.grouped', {}, '') : []),
    'plan:',
    `  intent_id: ${quote(input.intentCode)}`,
    ...say('plan.draft.file.change_flags', { flags: CHANGE_FLAGS.join(', ') }, '  '),
    `  change_flags: ${fill ? list(DRAFT_CHECK_VALUES.changeFlags) : 'null'}`,
    'tasks:',
  ];
  for (const task of input.tasks) {
    out.push(`  - id: ${quote(task.id)}`, `    summary: ${quote(task.summary)}`);
    if (task.dependsOn.length > 0) out.push(`    depends_on: ${list(task.dependsOn)}`);
    if (task.definitionOfDone.length > 0) {
      out.push(
        '    definition_of_done:',
        ...task.definitionOfDone.map((v) => `      - ${quote(v)}`),
      );
    }
    if (task.checkpoint) out.push(`    checkpoint: ${quote(task.checkpoint)}`);
    out.push(...say('plan.draft.file.allowed_paths', {}, '    '));
    if (task.pathHints.length > 0) {
      out.push(
        ...say('plan.draft.file.path_hints', {}, '    '),
        ...task.pathHints.map((path) => `    #   ${path}`),
      );
    }
    out.push(`    allowed_paths: ${fill ? list(DRAFT_CHECK_VALUES.allowedPaths) : 'null'}`);
    out.push(...say('plan.draft.file.tools', { tools: AGENT_TOOLS.join(', ') }, '    '));
    out.push(`    tools: ${fill ? list(DRAFT_CHECK_VALUES.tools) : 'null'}`);
  }
  return `${out.join('\n')}\n`;
}

/** The fields a person must fill, as paths into the file (`tasks[0].allowed_paths`). */
export function unfilledFields(tasks: readonly DraftTask[]): string[] {
  return [
    'plan.change_flags',
    ...tasks.flatMap((_, i) => [`tasks[${i}].allowed_paths`, `tasks[${i}].tools`]),
  ];
}
