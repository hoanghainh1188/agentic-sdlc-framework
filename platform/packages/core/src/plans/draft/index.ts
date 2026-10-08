// `sdlc plan draft`: a plan file draft from a Spec Kit task list or a BMAD story file (task S02,
// D-08 S02, design/ADR-M62, QUESTIONS #295–#297). Pure: text in, YAML out; the CLI reads and
// writes the files. The draft is never submitted, committed or pushed (QUESTIONS #167): a person
// fills the marked fields, commits the file and submits it.
import { parsePlanFile } from '../parse.js';
import { PLAN_MAX_BYTES, type PlanInvalidReason } from '../rules.js';
import { readBmadStory } from './bmad.js';
import { renderDraft, unfilledFields } from './render.js';
import { readSpecKitTasks } from './spec-kit.js';
import type { DraftRefusal, DraftTool } from './types.js';
import type { MessageKey } from '@sdlc/messages';

export {
  DRAFT_FIELD_MAX_CHARS,
  DRAFT_INPUT_MAX_BYTES,
  DRAFT_REFUSALS,
  DRAFT_TOOLS,
  type DraftRefusal,
  type DraftTask,
  type DraftTool,
} from './types.js';
export { DRAFT_CHECK_VALUES } from './render.js';

/** Catalog keys of the refusals (NFR-08). Parameters: `refusal` (a sentence), `path`, `code`. */
export const DRAFT_REFUSAL_MESSAGES = {
  input_missing: 'plan.draft.refusal.input_missing',
  input_not_a_file: 'plan.draft.refusal.input_not_a_file',
  input_too_large: 'plan.draft.refusal.input_too_large',
  input_not_utf8: 'plan.draft.refusal.input_not_utf8',
  epics_file: 'plan.draft.refusal.epics_file',
  no_tasks: 'plan.draft.refusal.no_tasks',
  template_text: 'plan.draft.refusal.template_text',
  too_many_tasks: 'plan.draft.refusal.too_many_tasks',
  draft_too_large: 'plan.draft.refusal.draft_too_large',
  draft_check_failed: 'plan.draft.refusal.draft_check_failed',
  output_exists: 'plan.draft.refusal.output_exists',
  no_repository: 'plan.draft.refusal.no_repository',
  write_failed: 'plan.draft.refusal.write_failed',
} as const satisfies Record<DraftRefusal, MessageKey>;

export interface DraftRequest {
  /** The tool's Markdown file, as UTF-8 text. */
  readonly text: string;
  readonly tool: DraftTool;
  readonly intentCode: string;
  readonly locale?: string;
}

export type PlanDraft =
  | {
      readonly ok: true;
      /** The plan file to write. */
      readonly yaml: string;
      readonly tasks: number;
      /** More than 20 items: one task per phase (QUESTIONS #295). */
      readonly grouped: boolean;
      /** Where the person must write values (`tasks[0].allowed_paths`). */
      readonly unfilled: readonly string[];
    }
  | {
      readonly ok: false;
      readonly refusal: DraftRefusal;
      /** The submission's reason, for `draft_check_failed`. */
      readonly planRefusal?: PlanInvalidReason;
    };

export function draftPlan(request: DraftRequest): PlanDraft {
  const read =
    request.tool === 'spec-kit' ? readSpecKitTasks(request.text) : readBmadStory(request.text);
  if (!read.ok) return read;
  // A task whose text is only control or bidirectional characters is not a task.
  if (read.tasks.some((task) => task.summary.length === 0)) {
    return { ok: false, refusal: 'template_text' };
  }
  const base = {
    intentCode: request.intentCode,
    tool: request.tool,
    tasks: read.tasks,
    grouped: read.grouped,
    ...(request.locale ? { locale: request.locale } : {}),
  };
  const yaml = renderDraft(base);
  if (Buffer.byteLength(yaml, 'utf8') > PLAN_MAX_BYTES)
    return { ok: false, refusal: 'draft_too_large' };
  // Self-check: filled with test values in memory, the draft passes submission (AC3).
  const check = parsePlanFile(renderDraft({ ...base, checkValues: true }), request.intentCode);
  if (!check.ok) return { ok: false, refusal: 'draft_check_failed', planRefusal: check.reason };
  return {
    ok: true,
    yaml,
    tasks: read.tasks.length,
    grouped: read.grouped,
    unfilled: unfilledFields(read.tasks),
  };
}
