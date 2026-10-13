// Evaluation tasks (task L02, design/ADR-M78 §2.3). A task set is a folder with `task-set.yaml`
// (version, repository, commit) and one folder per task: `task.yaml`, `spec.md` (what the agent
// reads), `hidden/` (tests the agent never sees, laid out like the repository), an optional
// `seed.patch` (a bug put into the base) and `solution.patch` (a reference fix, used only to check
// the task, never given to the agent). Everything is read and checked strictly: an unknown field,
// an unsafe path or an unsafe command refuses the whole set.
import fs from 'node:fs';
import path from 'node:path';

import { readYamlMapping } from '@sdlc/config';

export const TASK_KINDS = ['bug', 'feature'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export interface EvalTask {
  readonly id: string;
  readonly title: string;
  readonly kind: TaskKind;
  /** The D-09 task the shape follows (`T02`), or a feature code (`F4`) for a bug. */
  readonly shape: string;
  /** The plan's path patterns: the agent may change only these (G5 scope). */
  readonly plannedFiles: readonly string[];
  /** Commands that must pass after the hidden tests are added (the new behaviour). */
  readonly failToPass: readonly string[];
  /** Commands that must still pass on the agent's change, before the hidden tests are added. */
  readonly passToPass: readonly string[];
  /** The repository's own checks, run once on the agent's change ("CI on the first try"). */
  readonly ci: readonly string[];
  /** Absolute folder of the task. */
  readonly dir: string;
  /** The spec the agent reads (Markdown text). */
  readonly specText: string;
  /** The seed patch, or null when the base is the pinned commit as it is. */
  readonly seedPatch: string | null;
  /** The reference fix (task checks only). */
  readonly solutionPatch: string | null;
  /** Repository-relative paths of the hidden files, sorted. */
  readonly hiddenFiles: readonly string[];
}

export interface TaskSet {
  readonly version: number;
  readonly repository: string;
  readonly commit: string;
  readonly dir: string;
  readonly tasks: readonly EvalTask[];
}

export class TaskError extends Error {
  constructor(
    readonly where: string,
    message: string,
  ) {
    super(`${where}: ${message}`);
    this.name = 'TaskError';
  }
}

const ID = /^[a-z][a-z0-9-]{1,47}$/;
const SHAPE = /^[TF][0-9]{1,2}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const REPOSITORY = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.git$/;
// Commands run with `sh -c` in the scoring container: plain words only, no shell syntax.
const COMMAND = /^[A-Za-z0-9@][A-Za-z0-9 @/._:=-]{0,199}$/;
// A repository-relative path or glob: no `..`, no absolute path, no `.git`.
const PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!\.git(?:\/|$))[A-Za-z0-9._*/@-]{1,200}$/;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_LIST = 20;

function readText(file: string, where: string, required: boolean): string | null {
  if (!fs.existsSync(file)) {
    if (required) throw new TaskError(where, `${path.basename(file)} is missing`);
    return null;
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) throw new TaskError(where, `${path.basename(file)} is not a regular file`);
  if (stat.size > MAX_TEXT_BYTES) throw new TaskError(where, `${path.basename(file)} is too large`);
  return fs.readFileSync(file, 'utf8');
}

function readMapping(file: string, where: string): Record<string, unknown> {
  const text = readText(file, where, true)!;
  const parsed = readYamlMapping(text, { maxAliasCount: 0 });
  if (!parsed.ok) throw new TaskError(where, `${path.basename(file)} is not valid YAML`);
  return { ...parsed.value };
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], where: string): void {
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  if (extra.length > 0) throw new TaskError(where, `unknown field ${extra.join(', ')}`);
}

function text(value: unknown, pattern: RegExp, where: string, field: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new TaskError(where, `${field} is missing or has a wrong format`);
  }
  return value;
}

function list(value: unknown, pattern: RegExp, where: string, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LIST) {
    throw new TaskError(where, `${field} must be a list of 1 to ${String(MAX_LIST)} items`);
  }
  return value.map((item, i) => text(item, pattern, where, `${field}[${String(i)}]`));
}

/** Files under `hidden/`, repository-relative and sorted; links and odd names refused. */
function hiddenFiles(dir: string, where: string): string[] {
  const root = path.join(dir, 'hidden');
  if (!fs.existsSync(root)) throw new TaskError(where, 'hidden/ is missing');
  const found: string[] = [];
  const walk = (folder: string): void => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (entry.isSymbolicLink()) throw new TaskError(where, `hidden/${relative} is a link`);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && PATH.test(relative)) found.push(relative);
      else throw new TaskError(where, `hidden/${relative} is not allowed`);
    }
  };
  walk(root);
  if (found.length === 0) throw new TaskError(where, 'hidden/ holds no file');
  return found.sort();
}

const TASK_KEYS = [
  'schema',
  'id',
  'title',
  'kind',
  'shape',
  'planned_files',
  'fail_to_pass',
  'pass_to_pass',
  'ci',
] as const;

/** Reads and checks one task folder. */
export function loadTask(dir: string): EvalTask {
  const where = `task ${path.basename(dir)}`;
  const raw = readMapping(path.join(dir, 'task.yaml'), where);
  onlyKeys(raw, TASK_KEYS, where);
  if (raw.schema !== 1) throw new TaskError(where, 'schema must be 1');
  const id = text(raw.id, ID, where, 'id');
  if (id !== path.basename(dir)) throw new TaskError(where, 'id must equal the folder name');
  if (typeof raw.title !== 'string' || raw.title.length === 0 || raw.title.length > 120) {
    throw new TaskError(where, 'title is missing or too long');
  }
  if (!TASK_KINDS.includes(raw.kind as TaskKind)) throw new TaskError(where, 'kind is unknown');
  const kind = raw.kind as TaskKind;
  const seedPatch = readText(path.join(dir, 'seed.patch'), where, false);
  if (kind === 'bug' && seedPatch === null) throw new TaskError(where, 'a bug needs seed.patch');
  if (kind === 'feature' && seedPatch !== null) throw new TaskError(where, 'a feature has no seed');
  return {
    id,
    title: raw.title,
    kind,
    shape: text(raw.shape, SHAPE, where, 'shape'),
    plannedFiles: list(raw.planned_files, PATH, where, 'planned_files'),
    failToPass: list(raw.fail_to_pass, COMMAND, where, 'fail_to_pass'),
    passToPass: list(raw.pass_to_pass, COMMAND, where, 'pass_to_pass'),
    ci: list(raw.ci, COMMAND, where, 'ci'),
    dir,
    specText: readText(path.join(dir, 'spec.md'), where, true)!,
    seedPatch,
    solutionPatch: readText(path.join(dir, 'solution.patch'), where, false),
    hiddenFiles: hiddenFiles(dir, where),
  };
}

/**
 * Reads a task set; `only` keeps the named tasks (all of them must exist). Tasks are sorted by
 * id, so runs and reports have a stable order.
 */
export function loadTaskSet(dir: string, only?: readonly string[]): TaskSet {
  const where = `task set ${dir}`;
  const raw = readMapping(path.join(dir, 'task-set.yaml'), where);
  onlyKeys(raw, ['schema', 'version', 'repository', 'commit'], where);
  if (raw.schema !== 1) throw new TaskError(where, 'schema must be 1');
  if (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1) {
    throw new TaskError(where, 'version must be an integer of 1 or more');
  }
  const ids = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const wanted = only ?? ids;
  const unknown = wanted.filter((id) => !ids.includes(id));
  if (unknown.length > 0) throw new TaskError(where, `unknown task ${unknown.join(', ')}`);
  return {
    version: raw.version,
    repository: text(raw.repository, REPOSITORY, where, 'repository'),
    commit: text(raw.commit, COMMIT, where, 'commit'),
    dir,
    tasks: [...new Set(wanted)].sort().map((id) => loadTask(path.join(dir, id))),
  };
}
