// A project's own evaluation tasks (task L07, design/ADR-M85). A task is a card, the file
// `.sdlc/eval-tasks/<id>.yaml` on the project's default branch (schema 2 of the task format; the
// folders of `task.ts` are schema 1). A card holds codes, commits, paths and commands only: the
// spec, the code and the tests are read again from Git, never stored by the platform.
//
// This module is pure: it reads and writes cards, finds the hidden tests of a merged pull request
// and finds its base commit through a `CommitLookup` the caller gives (the Git host adapter).
import path from 'node:path';

import { readYamlMapping } from '@sdlc/config';

import { TaskError, type EvalTask } from './task.js';

export const TASK_CARD_DIR = '.sdlc/eval-tasks';
export const TASK_CARD_SCHEMA = 2;
/** A rebase merge longer than this is not followed back to its base (`base_unclear`). */
export const MAX_REBASE_COMMITS = 50;
const MAX_CARD_BYTES = 64 * 1024;
const MAX_LIST = 20;

const ID = /^[a-z][a-z0-9-]{1,47}$/;
const INTENT = /^INT-\d{4}-\d{4,9}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
// The same rules as `task.ts`: plain words for `sh -c`, and a path inside the repository.
const COMMAND = /^[A-Za-z0-9@][A-Za-z0-9 @/._:=-]{0,199}$/;
const PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!\.git(?:\/|$))[A-Za-z0-9._*/@ -]{1,200}$/;
const FILE_PLACEHOLDER = '{file}';

export interface TaskCardSpec {
  /** The spec's path on the default branch (`spec_refs`, ADR-M39). */
  readonly path: string;
  readonly commit: string;
  readonly sha256: string;
}

export interface TaskCard {
  readonly id: string;
  /** The intent's code (`INT-…`). */
  readonly intent: string;
  /** The commit before the change (ADR-M85 §2.3). */
  readonly baseCommit: string;
  /** The commit that merged the pull request. */
  readonly mergeCommit: string;
  readonly spec: TaskCardSpec;
  /** Test files the pull request added or changed: hidden from the agent. Sorted. */
  readonly hiddenTests: readonly string[];
  /** The pull request's other files: the agent may change only these (G5 scope). Sorted. */
  readonly plannedFiles: readonly string[];
  readonly failToPass: readonly string[];
  readonly passToPass: readonly string[];
  readonly ci: readonly string[];
}

/** The card's path for a task ID. */
export function taskCardPath(id: string): string {
  return `${TASK_CARD_DIR}/${id}.yaml`;
}

/** True when the path matches one of the test globs (Node's `path.posix.matchesGlob`, as G5). */
export function isTestFile(file: string, globs: readonly string[]): boolean {
  return globs.some((glob) => path.posix.matchesGlob(file, glob));
}

const CARD_KEYS = [
  'schema',
  'id',
  'intent',
  'base_commit',
  'merge_commit',
  'spec',
  'hidden_tests',
  'planned_files',
  'fail_to_pass',
  'pass_to_pass',
  'ci',
] as const;

function field(value: unknown, pattern: RegExp, where: string, name: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new TaskError(where, `${name} is missing or has a wrong format`);
  }
  return value;
}

function fieldList(
  value: unknown,
  pattern: RegExp,
  where: string,
  name: string,
  min: number,
): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > MAX_LIST) {
    throw new TaskError(
      where,
      `${name} must be a list of ${String(min)} to ${String(MAX_LIST)} items`,
    );
  }
  const items = value.map((item, i) => field(item, pattern, where, `${name}[${String(i)}]`));
  if (new Set(items).size !== items.length) throw new TaskError(where, `${name} has a duplicate`);
  return items;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], where: string): void {
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  if (extra.length > 0) throw new TaskError(where, `unknown field ${extra.join(', ')}`);
}

/**
 * Reads and checks a task card; `cardPath` is its path in the repository. Everything is checked
 * strictly: an unknown field, an unsafe path or command, or a card whose file name is not its ID
 * refuses the card. A card needs at least one command of each kind: a draft without commands is
 * refused until a person writes them.
 */
export function parseTaskCard(text: string, cardPath: string): TaskCard {
  const where = `task card ${cardPath}`;
  if (Buffer.byteLength(text, 'utf8') > MAX_CARD_BYTES) throw new TaskError(where, 'too large');
  const parsed = readYamlMapping(text, { maxAliasCount: 0 });
  if (!parsed.ok) throw new TaskError(where, 'not valid YAML');
  const raw: Record<string, unknown> = { ...parsed.value };
  onlyKeys(raw, CARD_KEYS, where);
  if (raw.schema !== TASK_CARD_SCHEMA) {
    throw new TaskError(where, `schema must be ${String(TASK_CARD_SCHEMA)}`);
  }
  const id = field(raw.id, ID, where, 'id');
  if (cardPath !== taskCardPath(id)) {
    throw new TaskError(where, `the path must be ${taskCardPath(id)}`);
  }
  if (typeof raw.spec !== 'object' || raw.spec === null || Array.isArray(raw.spec)) {
    throw new TaskError(where, 'spec is missing');
  }
  const spec = { ...(raw.spec as Record<string, unknown>) };
  onlyKeys(spec, ['path', 'commit', 'sha256'], where);
  const baseCommit = field(raw.base_commit, COMMIT, where, 'base_commit');
  const mergeCommit = field(raw.merge_commit, COMMIT, where, 'merge_commit');
  if (baseCommit === mergeCommit) {
    throw new TaskError(where, 'base_commit and merge_commit must differ');
  }
  const hiddenTests = fieldList(raw.hidden_tests, PATH, where, 'hidden_tests', 1);
  const plannedFiles = fieldList(raw.planned_files, PATH, where, 'planned_files', 1);
  const both = hiddenTests.filter((file) => plannedFiles.includes(file));
  if (both.length > 0) {
    throw new TaskError(where, `${both.join(', ')} is both a hidden test and a planned file`);
  }
  return {
    id,
    intent: field(raw.intent, INTENT, where, 'intent'),
    baseCommit,
    mergeCommit,
    spec: {
      path: field(spec.path, PATH, where, 'spec.path'),
      commit: field(spec.commit, COMMIT, where, 'spec.commit'),
      sha256: field(spec.sha256, SHA256, where, 'spec.sha256'),
    },
    hiddenTests: [...hiddenTests].sort(),
    plannedFiles: [...plannedFiles].sort(),
    failToPass: fieldList(raw.fail_to_pass, COMMAND, where, 'fail_to_pass', 1),
    passToPass: fieldList(raw.pass_to_pass, COMMAND, where, 'pass_to_pass', 1),
    ci: fieldList(raw.ci, COMMAND, where, 'ci', 1),
  };
}

/** A YAML list of quoted strings (every value matches a strict pattern, so JSON quoting is safe). */
function yamlList(items: readonly string[]): string {
  return items.length === 0 ? ' []' : items.map((item) => `\n  - ${JSON.stringify(item)}`).join('');
}

/**
 * Writes a card as YAML, fields in a fixed order. Commits and hashes are quoted: YAML would read a
 * commit of digits only (or digits with one `e`) as a number. A draft may have empty command lists: the person
 * writes them before the card is committed (`parseTaskCard` refuses empty lists).
 */
export function renderTaskCard(card: TaskCard): string {
  return [
    `# Evaluation task (design/ADR-M85). Made by \`sdlc eval task draft\` from ${card.intent}.`,
    '# Commit it to the default branch through a pull request, then register it.',
    `schema: ${String(TASK_CARD_SCHEMA)}`,
    `id: ${card.id}`,
    `intent: ${card.intent}`,
    `base_commit: ${JSON.stringify(card.baseCommit)}`,
    `merge_commit: ${JSON.stringify(card.mergeCommit)}`,
    'spec:',
    `  path: ${JSON.stringify(card.spec.path)}`,
    `  commit: ${JSON.stringify(card.spec.commit)}`,
    `  sha256: ${JSON.stringify(card.spec.sha256)}`,
    `hidden_tests:${yamlList(card.hiddenTests)}`,
    `planned_files:${yamlList(card.plannedFiles)}`,
    `fail_to_pass:${yamlList(card.failToPass)}`,
    `pass_to_pass:${yamlList(card.passToPass)}`,
    `ci:${yamlList(card.ci)}`,
    '',
  ].join('\n');
}

// ---------- Drafting a card from a merged pull request (ADR-M85 §2.2–§2.4) ----------

/** How a pull request changed a file, as the Git host reports it. */
export interface MergedFile {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied';
  readonly previousPath: string | null;
}

/** A merged pull request (the Git host's `getMergedChange`). */
export interface MergedPullRequest {
  readonly mergeCommitSha: string;
  readonly mergeCommitParents: readonly string[];
  readonly commitCount: number;
  readonly files: readonly MergedFile[];
}

/** The two Git host calls the base commit needs. */
export interface CommitLookup {
  getCommitParents(sha: string): Promise<readonly string[]>;
  compareChangedFiles(base: string, head: string): Promise<readonly string[]>;
}

/** Why a card cannot be drafted (codes for the catalog). */
export type DraftRefusal =
  'no_tests' | 'base_unclear' | 'too_many_files' | 'unsafe_path' | 'no_planned_files';

export type DraftResult =
  | { readonly ok: true; readonly card: TaskCard }
  | { readonly ok: false; readonly code: DraftRefusal };

/** The paths of a pull request as `getChangedFiles` gives them: both paths of a rename. */
function changedPaths(files: readonly MergedFile[]): string[] {
  const paths = new Set<string>();
  for (const file of files) {
    paths.add(file.path);
    if (file.previousPath !== null) paths.add(file.previousPath);
  }
  return [...paths].sort();
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((item, i) => item === b[i]);

/**
 * The base commit of a merged pull request (ADR-M85 §2.3, QUESTIONS #485): the first parent of a
 * merge commit; for one parent, the parent (squash) or the commit `commitCount` steps back (rebase
 * merge). A candidate counts only when the diff from it to the merge commit has exactly the pull
 * request's files. No candidate, or two different ones, is `base_unclear`.
 */
export async function findBaseCommit(
  change: MergedPullRequest,
  lookup: CommitLookup,
): Promise<string | null> {
  const parents = change.mergeCommitParents;
  if (parents.length === 0 || parents.length > 2) return null;
  const candidates = [parents[0]!];
  if (parents.length === 1 && change.commitCount > 1) {
    if (change.commitCount > MAX_REBASE_COMMITS) return null;
    let commit = change.mergeCommitSha;
    for (let step = 0; step < change.commitCount; step += 1) {
      const up = await lookup.getCommitParents(commit);
      // A merge commit inside the chain is not a rebase merge of this pull request.
      if (up.length !== 1) {
        commit = '';
        break;
      }
      commit = up[0]!;
    }
    if (commit !== '' && commit !== parents[0]) candidates.push(commit);
  }
  const wanted = changedPaths(change.files);
  const matching: string[] = [];
  for (const candidate of candidates) {
    const files = await lookup.compareChangedFiles(candidate, change.mergeCommitSha);
    if (sameList([...files].sort(), wanted)) matching.push(candidate);
  }
  return matching.length === 1 ? matching[0]! : null;
}

export interface DraftInput {
  readonly id: string;
  readonly intent: string;
  readonly change: MergedPullRequest;
  readonly spec: TaskCardSpec;
  /** `evaluation.tasks` of the project configuration. */
  readonly testGlobs: readonly string[];
  readonly commands: {
    readonly fail_to_pass: readonly string[];
    readonly pass_to_pass: readonly string[];
    readonly ci: readonly string[];
  };
}

/** `{file}` gives one command per hidden test; a command over the length limit is dropped. */
function expandCommands(templates: readonly string[], tests: readonly string[]): string[] {
  const out: string[] = [];
  for (const template of templates) {
    const expanded = template.includes(FILE_PLACEHOLDER)
      ? tests.map((test) => template.split(FILE_PLACEHOLDER).join(test))
      : [template];
    for (const command of expanded) {
      if (COMMAND.test(command) && !out.includes(command)) out.push(command);
    }
  }
  return out.slice(0, MAX_LIST);
}

/**
 * Drafts a card from a merged pull request (ADR-M85 §2.2, AC4): the hidden tests are the added or
 * changed files that match the test globs (a removed test is not one); the planned files are the
 * others. Refused without a test (`no_tests`), without a clear base (`base_unclear`), with a path
 * the card cannot hold (`unsafe_path`) or with more than 20 files of either kind.
 */
export async function draftTaskCard(input: DraftInput, lookup: CommitLookup): Promise<DraftResult> {
  if (!ID.test(input.id) || !INTENT.test(input.intent)) {
    throw new TaskError('task card draft', 'the task ID or the intent code has a wrong format');
  }
  const kept = input.change.files.filter((file) => file.status !== 'removed');
  const hiddenTests = kept
    .filter((file) => isTestFile(file.path, input.testGlobs))
    .map((file) => file.path)
    .sort();
  if (hiddenTests.length === 0) return { ok: false, code: 'no_tests' };
  const plannedFiles = changedPaths(input.change.files).filter(
    (file) => !hiddenTests.includes(file),
  );
  if (plannedFiles.length === 0) return { ok: false, code: 'no_planned_files' };
  if (hiddenTests.length > MAX_LIST || plannedFiles.length > MAX_LIST) {
    return { ok: false, code: 'too_many_files' };
  }
  if (![...hiddenTests, ...plannedFiles].every((file) => PATH.test(file))) {
    return { ok: false, code: 'unsafe_path' };
  }
  const baseCommit = await findBaseCommit(input.change, lookup);
  if (baseCommit === null) return { ok: false, code: 'base_unclear' };
  return {
    ok: true,
    card: {
      id: input.id,
      intent: input.intent,
      baseCommit,
      mergeCommit: input.change.mergeCommitSha,
      spec: input.spec,
      hiddenTests,
      plannedFiles,
      failToPass: expandCommands(input.commands.fail_to_pass, hiddenTests),
      passToPass: expandCommands(input.commands.pass_to_pass, hiddenTests),
      ci: expandCommands(input.commands.ci, hiddenTests),
    },
  };
}

/**
 * The task of a card, in the shape the base and the scoring take (task L07, ADR-M85 §2.5): the
 * spec text read from Git at the card's spec commit, no seed patch (the base is the commit before
 * the change), the hidden tests as files of the repository. Never written to disk as a task folder.
 */
export function taskOfCard(card: TaskCard, specText: string): EvalTask {
  return {
    id: card.id,
    title: card.id,
    kind: 'feature',
    shape: 'F0',
    plannedFiles: card.plannedFiles,
    failToPass: card.failToPass,
    passToPass: card.passToPass,
    ci: card.ci,
    dir: '',
    specText,
    seedPatch: null,
    solutionPatch: null,
    hiddenFiles: card.hiddenTests,
  };
}
