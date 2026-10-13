// The base of an evaluation run (task L02, design/ADR-M78 §2.3): the repository at the task set's
// pinned commit, the task's seed patch (a bug), the spec the agent reads, and the configuration's
// instructions in place of AGENTS.md. Committed, so the agent's diff is computed against it; the
// scoring container gets the same base as a patch on the pinned commit.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { EvalTask, TaskSet } from './task.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=eval',
      '-c',
      'user.email=eval@eval.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  ).trim();

/** A local clone of the task set's repository with its pinned commit (needs network once). */
export function ensureClone(cacheDir: string, set: Pick<TaskSet, 'repository' | 'commit'>): string {
  const dir = path.join(cacheDir, 'repository');
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(cacheDir, { recursive: true });
    execFileSync('git', ['clone', '-q', '--no-checkout', set.repository, dir]);
  }
  try {
    git(dir, 'cat-file', '-e', `${set.commit}^{commit}`);
  } catch {
    git(dir, 'fetch', '-q', 'origin', set.commit);
  }
  return dir;
}

/** Where the agent finds the task's spec. */
export const specPathFor = (task: Pick<EvalTask, 'id'>): string => `docs/specs/${task.id}.md`;

export interface PreparedBase {
  /** A repository whose HEAD is the base (branch `main`). */
  readonly repoDir: string;
  /** The base as a patch on the pinned commit, for the scoring container. */
  readonly basePatch: string;
  readonly specPath: string;
  /** SHA-256 of the AGENTS.md the agent reads. */
  readonly instructionsSha256: string;
}

/** Builds the base of one task and configuration in `workDir` (a new folder). */
export function prepareBase(input: {
  readonly clone: string;
  readonly commit: string;
  readonly task: EvalTask;
  readonly instructionsText: string | null;
  readonly workDir: string;
}): PreparedBase {
  const repoDir = path.join(input.workDir, 'base');
  execFileSync('git', ['clone', '-q', '--no-hardlinks', '--no-checkout', input.clone, repoDir]);
  git(repoDir, 'checkout', '-q', '-B', 'main', input.commit);
  if (input.task.seedPatch !== null) {
    execFileSync('git', ['apply', '--whitespace=nowarn', '-'], {
      cwd: repoDir,
      input: input.task.seedPatch,
    });
  }
  const specPath = specPathFor(input.task);
  fs.mkdirSync(path.dirname(path.join(repoDir, specPath)), { recursive: true });
  fs.writeFileSync(path.join(repoDir, specPath), input.task.specText);
  if (input.instructionsText !== null) {
    fs.writeFileSync(path.join(repoDir, 'AGENTS.md'), input.instructionsText);
  }
  git(repoDir, 'add', '-A');
  git(repoDir, 'commit', '-q', '-m', 'evaluation base');
  const agents = fs.readFileSync(path.join(repoDir, 'AGENTS.md'));
  return {
    repoDir,
    basePatch: `${git(repoDir, 'diff', '--binary', input.commit, 'HEAD')}\n`,
    specPath,
    instructionsSha256: crypto.createHash('sha256').update(agents).digest('hex'),
  };
}
