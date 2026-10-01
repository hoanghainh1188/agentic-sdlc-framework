// Which workspace paths a proposal leaves out (task C06 session 2b, Harry's review of PR #112):
// the paths the ignore rules of `base_sha` ignore, as git itself decides them. The rules are read
// from the runner's own clone, before the sandbox's files are laid over it, so a `.gitignore` the
// agent adds or changes never hides anything; its change still shows in the proposal.
//
// One `git check-ignore --stdin -z --verbose --non-matching` process answers every path, one
// record each (GIT_FLUSH=1), with the hardened options of `proposal.ts`; every path is sent as
// `./<path>`, so a name that looks like pathspec magic stays a name. Paths git tracks at
// `base_sha` are never ignored (git's own rule), and a directory that holds a tracked path is
// never skipped as a whole. A path under something that is not a real directory in the clone is
// kept without asking git (git refuses paths beyond a symbolic link). If git stops anyway (for
// example a path inside a submodule), the proposal fails (`agent_proposal_failed`).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { RunnerError } from '../errors.js';
import { gitArgs, gitEnv } from './proposal.js';
import type { EntryFilter, WorkspaceEntry } from './untar.js';

function failed(): RunnerError {
  return new RunnerError('runner.workspace.proposal_failed');
}

/** Runs `git ls-files -z` in the clone: the paths tracked at `base_sha`. */
function trackedPaths(repoDir: string, home: string, timeoutMs: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', gitArgs(repoDir, ['ls-files', '-z']), {
      env: gitEnv(home),
      timeout: timeoutMs,
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.resume();
    child.on('error', () => reject(failed()));
    child.on('close', (code) => {
      if (code !== 0) return reject(failed());
      resolve(
        Buffer.concat(chunks)
          .toString('utf8')
          .split('\0')
          .filter((p) => p.length > 0),
      );
    });
  });
}

export class IgnoreChecker {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #repoDir: string;
  /** Directories that hold a tracked path: never skipped as a whole. */
  readonly #trackedDirs: ReadonlySet<string>;
  readonly #waiting: ((ignored: boolean) => void)[] = [];
  readonly #failures: ((error: Error) => void)[] = [];
  #fields: string[] = [];
  #partial = '';
  #dead: Error | undefined;
  /** Number of questions asked (for the measurement in the PR). */
  asked = 0;

  private constructor(repoDir: string, home: string, tracked: readonly string[]) {
    this.#repoDir = repoDir;
    const dirs = new Set<string>();
    for (const file of tracked) {
      const parts = file.split('/');
      for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join('/'));
    }
    this.#trackedDirs = dirs;
    this.#child = spawn(
      'git',
      gitArgs(repoDir, ['check-ignore', '--stdin', '-z', '--verbose', '--non-matching']),
      { env: { ...gitEnv(home), GIT_FLUSH: '1' } },
    );
    this.#child.stdout.setEncoding('utf8');
    this.#child.stdout.on('data', (text: string) => this.#read(text));
    this.#child.stderr.resume();
    this.#child.stdin.on('error', () => this.#fail());
    this.#child.on('error', () => this.#fail());
    this.#child.on('close', () => this.#fail());
  }

  static async start(repoDir: string, home: string, timeoutMs: number): Promise<IgnoreChecker> {
    return new IgnoreChecker(repoDir, home, await trackedPaths(repoDir, home, timeoutMs));
  }

  /** Four NUL-terminated fields per path: source, line, pattern, path. */
  #read(text: string): void {
    const parts = (this.#partial + text).split('\0');
    this.#partial = parts.pop() ?? '';
    for (const part of parts) {
      this.#fields.push(part);
      if (this.#fields.length < 4) continue;
      const [source, , pattern] = this.#fields;
      this.#fields = [];
      this.#failures.shift();
      // A match of a negated pattern (`!keep.log`) means the path is not ignored.
      this.#waiting.shift()?.(source !== '' && !pattern!.startsWith('!'));
    }
  }

  #fail(): void {
    this.#dead ??= failed();
    for (const reject of this.#failures.splice(0)) reject(this.#dead);
    this.#waiting.length = 0;
  }

  /** True when a leading component in the clone is a link or anything but a directory. */
  #beyondLink(rel: string): boolean {
    const parts = rel.split('/');
    let current = this.#repoDir;
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current, { throwIfNoEntry: false });
      if (!stat) return false; // not in the clone: nothing git could stumble on
      if (!stat.isDirectory()) return true;
    }
    return false;
  }

  #ask(query: string): Promise<boolean> {
    if (this.#dead) return Promise.reject(this.#dead);
    this.asked += 1;
    return new Promise((resolve, reject) => {
      this.#waiting.push(resolve);
      this.#failures.push(reject);
      // `./` first: a name such as `:(glob)x` is a path, never pathspec magic.
      this.#child.stdin.write(`./${query}\0`);
    });
  }

  /** The filter for `untarWorkspace`. */
  readonly filter: EntryFilter = async (rel: string, type: WorkspaceEntry['type']) => {
    if (this.#beyondLink(rel)) return 'keep';
    if (type === 'dir') {
      if (this.#trackedDirs.has(rel)) return 'keep';
      // A trailing slash tells git it is a directory (`node_modules/` patterns).
      return (await this.#ask(`${rel}/`)) ? 'skip_tree' : 'keep';
    }
    return (await this.#ask(rel)) ? 'skip' : 'keep';
  };

  close(): void {
    this.#child.stdin.end();
    if (this.#child.exitCode === null) this.#child.kill();
  }
}
