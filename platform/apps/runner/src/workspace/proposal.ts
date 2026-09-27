// The proposal of an L1 run, computed outside the sandbox (task C06 session 2b, D-09 T09,
// design/ADR-M33 §2.9, QUESTIONS #111; Harry's conditions).
//
// 1. `mirrorWorkspace` lays the sandbox's files (`untarWorkspace`) over the runner's own clone,
//    made from the Git host before the sandbox existed:
//    - every path is written through real directories only: a parent that is a symbolic link (or
//      anything but a directory) is refused, so nothing is ever written outside the clone;
//    - files are written with O_NOFOLLOW; symbolic links are created as links, never followed;
//    - deletions are mirrored: a file of the clone that is not in the archive is removed;
//    - `.git` (at any depth, compared folded: `.GIT` too) is never touched: the runner's `.git`
//      stays the reference;
//    - two entries whose paths fold to the same path are refused: on a case-insensitive file
//      system they would be one file (security review).
// 2. `computeProposal` runs hardened git in the clone: no system or user configuration, no hooks,
//    no fsmonitor, no replace objects, no external diff or textconv. `git add -A`, then the binary
//    diff of the index against `base_sha`, and the changed paths. Nothing the sandbox reports is
//    used. C07 and C08 can reuse both to recompute changed files outside the sandbox.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { RunnerError } from '../errors.js';
import { foldPath, isGitPath, type WorkspaceEntry } from './untar.js';

function invalid(): RunnerError {
  return new RunnerError('runner.workspace.archive_invalid');
}

/** Checks that every parent of `rel` inside `root` is a real directory (lstat, no symlink). */
function assertRealParents(root: string, rel: string): void {
  const parts = rel.split('/').slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) throw invalid();
  }
}

/** Every path under `root` (lstat, no link followed), `.git` left out; deepest first. */
function listTree(root: string): { rel: string; stat: fs.Stats }[] {
  const found: { rel: string; stat: fs.Stats }[] = [];
  const walk = (dirRel: string) => {
    for (const name of fs.readdirSync(path.join(root, dirRel))) {
      if (isGitPath(name)) continue;
      const rel = dirRel ? `${dirRel}/${name}` : name;
      const stat = fs.lstatSync(path.join(root, rel));
      if (stat.isDirectory()) walk(rel);
      found.push({ rel, stat });
    }
  };
  walk('');
  return found;
}

function kindOf(stat: fs.Stats): 'dir' | 'file' | 'symlink' | 'other' {
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isDirectory()) return 'dir';
  if (stat.isFile()) return 'file';
  return 'other';
}

/** SHA-256 of the clone's git configuration, or null when there is none. */
function gitConfigHash(cloneDir: string): string | null {
  const file = path.join(cloneDir, '.git', 'config');
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile()) return 'not-a-file';
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Makes the clone's working tree (outside `.git`) equal to the archive's entries. The git
 * configuration must be the same before and after (defence in depth: a changed configuration
 * could make git run a program).
 */
export function mirrorWorkspace(cloneDir: string, entries: readonly WorkspaceEntry[]): void {
  const configBefore = gitConfigHash(cloneDir);
  mirrorEntries(cloneDir, entries);
  if (gitConfigHash(cloneDir) !== configBefore) throw invalid();
}

function mirrorEntries(cloneDir: string, entries: readonly WorkspaceEntry[]): void {
  const wanted = new Map<string, WorkspaceEntry>();
  const folded = new Set<string>();
  for (const entry of entries) {
    if (isGitPath(entry.path)) throw invalid();
    const fold = foldPath(entry.path);
    if (folded.has(fold)) throw invalid();
    folded.add(fold);
    wanted.set(entry.path, entry);
  }
  // Parents of every entry must be directories in the archive too (Docker always lists them).
  for (const entry of entries) {
    const parent = path.posix.dirname(entry.path);
    if (parent !== '.' && wanted.get(parent)?.type !== 'dir') throw invalid();
  }

  // 1. Remove what is not wanted, or wanted as another kind (deepest first: listTree order).
  for (const { rel, stat } of listTree(cloneDir)) {
    const target = wanted.get(rel);
    if (target && target.type === kindOf(stat)) continue;
    fs.rmSync(path.join(cloneDir, rel), { recursive: true, force: true });
  }

  // 2. Directories, shallow first, then links and files.
  const dirs = [...wanted.values()]
    .filter((e) => e.type === 'dir')
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  for (const dir of dirs) {
    assertRealParents(cloneDir, dir.path);
    const full = path.join(cloneDir, dir.path);
    const stat = fs.lstatSync(full, { throwIfNoEntry: false });
    if (!stat) fs.mkdirSync(full, { mode: 0o755 });
    else if (!stat.isDirectory()) throw invalid();
  }
  for (const entry of wanted.values()) {
    if (entry.type === 'dir') continue;
    assertRealParents(cloneDir, entry.path);
    const full = path.join(cloneDir, entry.path);
    if (entry.type === 'symlink') {
      fs.rmSync(full, { force: true });
      fs.symlinkSync(entry.target, full);
      continue;
    }
    const existing = fs.lstatSync(full, { throwIfNoEntry: false });
    if (existing && !existing.isFile()) fs.rmSync(full, { recursive: true, force: true });
    const fd = fs.openSync(
      full,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
      0o644,
    );
    try {
      fs.writeSync(fd, entry.content);
      fs.fchmodSync(fd, entry.executable ? 0o755 : 0o644);
    } finally {
      fs.closeSync(fd);
    }
  }
}

export interface ProposalGitOptions {
  readonly timeoutMs: number;
  /** Upper bound of the patch, in bytes. */
  readonly maxPatchBytes: number;
}

export interface Proposal {
  /** `git diff --binary` of the proposal against `base_sha`. */
  readonly patch: Buffer;
  /** Changed paths (a rename is a delete and an add). Client data: never in run events. */
  readonly changedFiles: readonly string[];
}

const SHA = /^[0-9a-f]{40}$/;

/** Hardened git in the runner's clone: no configuration, hooks, fsmonitor or replace objects. */
function gitIn(
  repoDir: string,
  home: string,
  args: string[],
  options: ProposalGitOptions,
): Promise<Buffer> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
  const safety = [
    '--no-replace-objects',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.autocrlf=false',
    '-c',
    'core.symlinks=true',
    '-c',
    'diff.external=',
  ];
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...safety, '-C', repoDir, ...args],
      { env, timeout: options.timeoutMs, maxBuffer: options.maxPatchBytes, encoding: 'buffer' },
      (error, stdout) => {
        // Git's own text is never passed on.
        if (error) reject(new RunnerError('runner.workspace.proposal_failed'));
        else resolve(stdout);
      },
    );
  });
}

/** The proposal: stages the mirrored tree in the runner's clone and diffs it against `baseSha`. */
export async function computeProposal(
  repoDir: string,
  home: string,
  baseSha: string,
  options: ProposalGitOptions,
): Promise<Proposal> {
  if (!SHA.test(baseSha)) throw new RunnerError('runner.workspace.proposal_failed');
  await gitIn(repoDir, home, ['add', '-A', '--', '.'], options);
  const diffArgs = ['diff', '--cached', '--no-renames', '--no-ext-diff', '--no-textconv'];
  const patch = await gitIn(
    repoDir,
    home,
    [...diffArgs, '--binary', '--full-index', baseSha],
    options,
  );
  const names = await gitIn(repoDir, home, [...diffArgs, '--name-only', '-z', baseSha], options);
  const changedFiles = names
    .toString('utf8')
    .split('\0')
    .filter((name) => name.length > 0);
  return { patch, changedFiles };
}
