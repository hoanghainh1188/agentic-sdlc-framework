// The size of a run's change a person must review (task H05, D-08 H05 AC1, design/ADR-M95 §2.2,
// QUESTIONS #456, #601–#603). Measured outside the sandbox, after `computeRunPatch` staged the
// mirrored tree in the runner's clone, with hardened git:
// 1. `git diff --cached --numstat -z --no-renames <base>`: added and removed lines per changed
//    path (a rename is a delete and an add, as in the stored diff); a binary file shows `-` and
//    counts as one file and no lines.
// 2. Generated files are counted apart, never against the limits: lock files (by file name,
//    `LOCK_FILE_NAMES`) and the files the base commit's `.gitattributes` marks
//    `linguist-generated`. The attributes are read from a temporary index of `base_sha`
//    (`read-tree`, then `check-attr --cached`), so a `.gitattributes` the agent added or changed
//    is never read: the agent cannot mark its own change as generated.
// The run event `diff_measured` holds the result and counts only, never a path. A failed
// measurement is recorded, never thrown: G5 holds the run on it (QUESTIONS #603).
import fs from 'node:fs';
import path from 'node:path';

import { gitIn } from './proposal.js';

/** Lock files, by file name: counted apart from the change a person reviews (QUESTIONS #602). */
export const LOCK_FILE_NAMES: readonly string[] = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'deno.lock',
  'go.sum',
  'Cargo.lock',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock',
  'pdm.lock',
  'composer.lock',
  'Gemfile.lock',
  'Podfile.lock',
  'pubspec.lock',
  'mix.lock',
  'flake.lock',
  'packages.lock.json',
  'gradle.lockfile',
];

/** The attribute that marks a generated file (GitHub Linguist's, read by many tools). */
export const GENERATED_ATTRIBUTE = 'linguist-generated';

/** Paths per `check-attr` call: keeps the argument list well below the system limit. */
const CHECK_ATTR_BATCH = 500;

export type ReviewSizeCause = 'numstat_failed' | 'attributes_failed';

export interface ReviewSize {
  readonly result: 'measured' | 'failed';
  /** Files and lines (added plus removed) a person reviews: generated files left out. */
  readonly reviewFiles: number;
  readonly reviewLines: number;
  readonly generatedFiles: number;
  readonly generatedLines: number;
  /** Binary files among all changed files (each one file, no lines). */
  readonly binaryFiles: number;
  readonly cause?: ReviewSizeCause;
}

/** One `--numstat` entry. Null counts: a binary file. Client data: never in run events. */
export interface NumstatEntry {
  readonly path: string;
  readonly added: number | null;
  readonly removed: number | null;
}

export interface MeasureInput {
  /** The runner's clone (`repo` and `home`), staged by `computeRunPatch`. */
  readonly cloneDir: string;
  readonly baseSha: string;
  readonly timeoutMs: number;
  /** Upper bound of git's output, in bytes. */
  readonly maxOutputBytes: number;
}

const COUNT = /^(0|[1-9][0-9]*)$/;

/**
 * Parses `git diff --numstat -z --no-renames`: `<added>\t<removed>\t<path>\0` per file, `-\t-` for
 * a binary file. Null when an entry is malformed (the measurement then fails closed).
 */
export function parseNumstat(output: Buffer | string): NumstatEntry[] | null {
  const records = (typeof output === 'string' ? output : output.toString('utf8'))
    .split('\0')
    .filter((record) => record.length > 0);
  const entries: NumstatEntry[] = [];
  for (const record of records) {
    const first = record.indexOf('\t');
    const second = first < 0 ? -1 : record.indexOf('\t', first + 1);
    if (second < 0) return null;
    const added = record.slice(0, first);
    const removed = record.slice(first + 1, second);
    const file = record.slice(second + 1);
    if (file.length === 0) return null;
    if (added === '-' && removed === '-') {
      entries.push({ path: file, added: null, removed: null });
    } else if (COUNT.test(added) && COUNT.test(removed)) {
      entries.push({ path: file, added: Number(added), removed: Number(removed) });
    } else {
      return null;
    }
  }
  return entries;
}

/**
 * Parses `git check-attr -z`: `<path>\0<attribute>\0<value>\0` per path. Returns the paths whose
 * attribute is set (`set` or `true`); null when the output is malformed.
 */
export function parseCheckAttr(output: Buffer | string): Set<string> | null {
  const fields = (typeof output === 'string' ? output : output.toString('utf8')).split('\0');
  // A trailing NUL leaves one empty field.
  if (fields.at(-1) === '') fields.pop();
  if (fields.length % 3 !== 0) return null;
  const marked = new Set<string>();
  for (let i = 0; i < fields.length; i += 3) {
    const value = fields[i + 2];
    if (value === 'set' || value === 'true') marked.add(fields[i]!);
  }
  return marked;
}

/** A lock file, by its file name. */
export function isLockFile(file: string): boolean {
  return LOCK_FILE_NAMES.includes(path.posix.basename(file));
}

/** The counts of the entries, with `generated` the paths counted apart. */
export function countReviewSize(
  entries: readonly NumstatEntry[],
  generated: ReadonlySet<string>,
): ReviewSize {
  let reviewFiles = 0;
  let reviewLines = 0;
  let generatedFiles = 0;
  let generatedLines = 0;
  let binaryFiles = 0;
  for (const entry of entries) {
    const lines = (entry.added ?? 0) + (entry.removed ?? 0);
    if (entry.added === null) binaryFiles += 1;
    if (generated.has(entry.path) || isLockFile(entry.path)) {
      generatedFiles += 1;
      generatedLines += lines;
    } else {
      reviewFiles += 1;
      reviewLines += lines;
    }
  }
  return {
    result: 'measured',
    reviewFiles,
    reviewLines,
    generatedFiles,
    generatedLines,
    binaryFiles,
  };
}

const failed = (cause: ReviewSizeCause): ReviewSize => ({
  result: 'failed',
  reviewFiles: 0,
  reviewLines: 0,
  generatedFiles: 0,
  generatedLines: 0,
  binaryFiles: 0,
  cause,
});

/** The paths the base commit's `.gitattributes` files mark generated (see the header). */
async function generatedAtBase(
  input: MeasureInput,
  paths: readonly string[],
): Promise<Set<string>> {
  const repoDir = path.join(input.cloneDir, 'repo');
  const home = path.join(input.cloneDir, 'home');
  const indexFile = path.join(input.cloneDir, 'review-size.index');
  const options = { timeoutMs: input.timeoutMs, maxPatchBytes: input.maxOutputBytes, indexFile };
  fs.rmSync(indexFile, { force: true });
  try {
    await gitIn(repoDir, home, ['read-tree', input.baseSha], options);
    const marked = new Set<string>();
    for (let i = 0; i < paths.length; i += CHECK_ATTR_BATCH) {
      const batch = paths.slice(i, i + CHECK_ATTR_BATCH);
      const output = await gitIn(
        repoDir,
        home,
        ['check-attr', '--cached', '-z', GENERATED_ATTRIBUTE, '--', ...batch],
        options,
      );
      const set = parseCheckAttr(output);
      if (set === null) throw new Error('check-attr output');
      for (const file of set) marked.add(file);
    }
    return marked;
  } finally {
    fs.rmSync(indexFile, { force: true });
  }
}

/** Measures the staged change against `baseSha` (see the header). Never throws. */
export async function measureReviewSize(input: MeasureInput): Promise<ReviewSize> {
  const repoDir = path.join(input.cloneDir, 'repo');
  const home = path.join(input.cloneDir, 'home');
  const options = { timeoutMs: input.timeoutMs, maxPatchBytes: input.maxOutputBytes };
  let entries: NumstatEntry[] | null;
  try {
    const output = await gitIn(
      repoDir,
      home,
      [
        'diff',
        '--cached',
        '--no-renames',
        '--no-ext-diff',
        '--no-textconv',
        '--numstat',
        '-z',
        input.baseSha,
      ],
      options,
    );
    entries = parseNumstat(output);
  } catch {
    entries = null;
  }
  if (entries === null) return failed('numstat_failed');
  let generated: Set<string>;
  try {
    generated = await generatedAtBase(
      input,
      entries.map((entry) => entry.path),
    );
  } catch {
    return failed('attributes_failed');
  }
  return countReviewSize(entries, generated);
}
