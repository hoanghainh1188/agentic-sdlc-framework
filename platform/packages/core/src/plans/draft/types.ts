// Types and limits of a plan draft (task S02, D-08 S02, design/ADR-M62, QUESTIONS #295–#297).

/** The tools a draft is read from (the pinned versions of ADR-M61 §2.2). */
export const DRAFT_TOOLS = ['spec-kit', 'bmad'] as const;
export type DraftTool = (typeof DRAFT_TOOLS)[number];

/** Why no draft is written. Codes only; texts are `plan.draft.refusal.<code>`. */
export const DRAFT_REFUSALS = [
  /** The source file cannot be opened. */
  'input_missing',
  /** The source path is not a regular file. */
  'input_not_a_file',
  /** The source file is larger than `DRAFT_INPUT_MAX_BYTES`. */
  'input_too_large',
  /** The source file is not UTF-8 text. */
  'input_not_utf8',
  /** A BMAD epics file: one intent is one story, so the story file is read (QUESTIONS #296). */
  'epics_file',
  /** No task list in the tool's format. */
  'no_tasks',
  /** A task still holds template text (`[Entity1]`, `Task 1 (AC: #)`). */
  'template_text',
  /** More than 20 tasks, also after grouping by phase (QUESTIONS #295). */
  'too_many_tasks',
  /** The draft is larger than the plan file limit (64 KiB). */
  'draft_too_large',
  /** The draft, once filled, would not pass submission (`planRefusal` says why). */
  'draft_check_failed',
  /** The plan file exists; `--force` replaces it. */
  'output_exists',
  /** No `.git` in the current folder or a parent, and no `--output`. */
  'no_repository',
  /** The plan file could not be written. */
  'write_failed',
] as const;
export type DraftRefusal = (typeof DRAFT_REFUSALS)[number];

/** Largest source file read, in bytes: the spec limit (256 KiB). */
export const DRAFT_INPUT_MAX_BYTES = 256 * 1024;
/** Longest text value written, in characters: the runner's cap per plan field. */
export const DRAFT_FIELD_MAX_CHARS = 2000;
/** Items of one list value (`definition_of_done`, `depends_on`). */
export const DRAFT_LIST_MAX_ITEMS = 100;
/** Suggested paths per task (comments only, never values). */
export const DRAFT_PATH_HINTS_MAX = 20;

/** One task of a draft, read from the tool's file. Text is the person's own file, kept local. */
export interface DraftTask {
  readonly id: string;
  readonly summary: string;
  readonly dependsOn: readonly string[];
  readonly definitionOfDone: readonly string[];
  readonly checkpoint?: string;
  /** Paths named in the source: written as comments under `allowed_paths`, never as values. */
  readonly pathHints: readonly string[];
}

/** What a reader found: the tasks, or why there are none. */
export type DraftRead =
  | { readonly ok: true; readonly tasks: readonly DraftTask[]; readonly grouped: boolean }
  | { readonly ok: false; readonly refusal: DraftRefusal };
